// Run with: cd server && npm test
//
// autoIndex is off (config/db.js), so the ONLY thing that creates indexes is utils/migrateIndexes.js. If it silently missed
// one, a unique constraint (an email, a share id, one active emergency request) or a TTL (sessions, rate-limit windows,
// codes) would simply not exist in production. This compares what every model DECLARES (schema.indexes(), which includes
// field-level index / unique / expires) with what the database actually HAS after the migration ran on an empty database:
// keys, unique, sparse, partial filters and expireAfterSeconds must all match.
// Uses a LOCAL throwaway MongoDB (test/helpers/realMongo.js); skipped, with the reason, without one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.env.NODE_ENV = 'test';
delete process.env.VERCEL;

const { connectThrowaway, disconnectThrowaway, mongoose } = require('./helpers/realMongo');

const MODELS_DIR = path.join(__dirname, '..', 'models');
const modelFiles = fs.readdirSync(MODELS_DIR).filter((file) => file.endsWith('.js'));
for (const file of modelFiles) require(path.join(MODELS_DIR, file)); // eslint-disable-line global-require

const { migrateIndexes, indexSignature } = require('../utils/migrateIndexes');

let connected = { ok: false, reason: '' };
test.before(async () => {
  connected = await connectThrowaway('index_coverage');
  // Mongoose must not build anything by itself here: only the migration may.
  mongoose.set('autoIndex', false);
});
test.after(disconnectThrowaway);
const it = (name, fn) =>
  test(name, async (context) => {
    if (!connected.ok) return context.skip(connected.reason);
    return fn(context);
  });

const keyOf = (fields) => JSON.stringify(fields);
const describeIndex = (key, options = {}) =>
  `${keyOf(key)}${options.unique ? ' unique' : ''}${options.sparse ? ' sparse' : ''}${
    options.partialFilterExpression ? ` partial=${JSON.stringify(options.partialFilterExpression)}` : ''
  }${options.expireAfterSeconds !== undefined ? ` ttl=${options.expireAfterSeconds}s` : ''}`;

async function actualIndexes(model) {
  try {
    return (await model.collection.indexes()).filter((index) => index.name !== '_id_');
  } catch (err) {
    if (err.codeName === 'NamespaceNotFound') return [];
    throw err;
  }
}

/** Every declared index of a model that the database does not have, or has with different options. */
function gaps(model, actual) {
  const found = [];
  for (const [fields, options = {}] of model.schema.indexes()) {
    const real = actual.find((index) => keyOf(index.key) === keyOf(fields));
    if (!real) {
      found.push(`${model.modelName}: missing ${describeIndex(fields, options)}`);
      continue;
    }
    if (Boolean(real.unique) !== Boolean(options.unique)) found.push(`${model.modelName}: ${keyOf(fields)} unique should be ${Boolean(options.unique)}`);
    if (Boolean(real.sparse) !== Boolean(options.sparse)) found.push(`${model.modelName}: ${keyOf(fields)} sparse should be ${Boolean(options.sparse)}`);
    if (real.expireAfterSeconds !== options.expireAfterSeconds) {
      found.push(`${model.modelName}: ${keyOf(fields)} expireAfterSeconds is ${real.expireAfterSeconds}, should be ${options.expireAfterSeconds}`);
    }
    try {
      assert.deepEqual(real.partialFilterExpression, options.partialFilterExpression);
    } catch {
      found.push(`${model.modelName}: ${keyOf(fields)} partial filter differs`);
    }
  }
  return found;
}

it('every model file is registered with Mongoose (so the migration sees it)', () => {
  assert.equal(modelFiles.length, 20, 'a model was added or removed: update this count and check its indexes below');
  assert.equal(mongoose.modelNames().length, modelFiles.length);
});

it('the migration builds EVERY declared index (unique, partial, sparse and TTL included) on an empty database', async (context) => {
  await mongoose.connection.dropDatabase();
  const result = await migrateIndexes();
  assert.equal(result.built, true);

  const report = [];
  const problems = [];
  const extra = [];
  for (const model of Object.values(mongoose.models).sort((a, b) => a.modelName.localeCompare(b.modelName))) {
    const actual = await actualIndexes(model);
    problems.push(...gaps(model, actual));
    const declared = model.schema.indexes();
    // An index nobody declared would be a leftover or a typo.
    for (const index of actual) if (!declared.some(([fields]) => keyOf(fields) === keyOf(index.key))) extra.push(`${model.modelName}: undeclared ${keyOf(index.key)}`);
    report.push(`${model.modelName} (${model.collection.name}): ${declared.map(([fields, options]) => describeIndex(fields, options)).join(' | ') || '(only _id)'}`);
  }
  context.diagnostic(`\n${report.join('\n')}`);
  assert.deepEqual(problems, [], `declared but not (correctly) built:\n${problems.join('\n')}`);
  assert.deepEqual(extra, [], `built but never declared:\n${extra.join('\n')}`);
});

it('the TTL indexes keep their exact expireAfterSeconds', async () => {
  const ttl = {};
  for (const model of Object.values(mongoose.models)) {
    for (const index of await actualIndexes(model)) if (index.expireAfterSeconds !== undefined) ttl[`${model.modelName}.${Object.keys(index.key)[0]}`] = index.expireAfterSeconds;
  }
  // Every TTL here is "expire at the date stored in the field" (0 seconds after it).
  assert.ok(Object.keys(ttl).length >= 10, 'expected the TTL indexes of sessions, codes, shares, rate limits...');
  for (const [name, seconds] of Object.entries(ttl)) assert.equal(seconds, 0, `${name} should expire exactly at its date`);
  for (const key of ['Session.expiresAt', 'RateLimit.windowExpiresAt', 'Document.purgeAt', 'AuditEvent.expiresAt', 'OtpChallenge.expiresAt']) assert.ok(key in ttl, `${key} must be a TTL index`);
});

it('the unique indexes that guard the app exist and really reject a duplicate', async () => {
  const RateLimit = mongoose.models.RateLimit;
  await RateLimit.create({ bucket: 'cov', key: 'a', count: 1, windowExpiresAt: new Date(Date.now() + 60000) });
  await assert.rejects(RateLimit.create({ bucket: 'cov', key: 'a', count: 1, windowExpiresAt: new Date(Date.now() + 60000) }), (err) => err.code === 11000);
  // The partial unique index: only ONE active emergency request per access, any number of inactive ones.
  const actual = await actualIndexes(mongoose.models.EmergencyRequest);
  const partial = actual.find((index) => index.partialFilterExpression);
  assert.ok(partial?.unique, 'accessId+active must be a partial unique index');
});

it('the migration is idempotent: a second run builds nothing, a forced re-run changes nothing', async () => {
  const snapshot = async () => {
    const all = {};
    for (const model of Object.values(mongoose.models)) all[model.collection.name] = (await actualIndexes(model)).map((index) => `${index.name}:${keyOf(index.key)}:${index.expireAfterSeconds}`).sort();
    return all;
  };
  const before = await snapshot();
  const again = await migrateIndexes();
  assert.equal(again.built, false, 'the marker says these exact indexes were built');
  assert.deepEqual(await snapshot(), before);

  // Two instances starting together, with the marker gone: both build, nothing breaks, nothing is duplicated.
  await mongoose.connection.db.collection('migrations').deleteOne({ _id: again.id });
  const [one, two] = await Promise.all([migrateIndexes(), migrateIndexes()]);
  assert.equal(one.built && two.built, true);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await migrateIndexes()).built, false);
});

it('an unchanged start costs one marker read; the hash changes only when a declared index changes', async () => {
  const models = Object.values(mongoose.models);
  const hash = indexSignature(models);
  assert.equal(indexSignature(models), hash);
  const Document = mongoose.models.Document;
  Document.schema.index({ zzTemporary: 1 });
  try {
    assert.notEqual(indexSignature(models), hash);
  } finally {
    Document.schema._indexes = Document.schema._indexes.filter(([fields]) => !('zzTemporary' in fields));
  }
  assert.equal(indexSignature(models), hash);

  let reads = 0;
  const collection = mongoose.connection.db.collection('migrations');
  const originalFindOne = collection.findOne;
  const originalCreate = mongoose.Model.createIndexes;
  let builds = 0;
  mongoose.Model.createIndexes = function counted(...args) { builds += 1; return originalCreate.apply(this, args); };
  const spy = mongoose.connection.db.collection.bind(mongoose.connection.db);
  mongoose.connection.db.collection = (name, ...rest) => {
    const real = spy(name, ...rest);
    if (name === 'migrations') return new Proxy(real, { get: (target, key) => (key === 'findOne' ? (...a) => { reads += 1; return target.findOne(...a); } : target[key].bind?.(target) ?? target[key]) });
    return real;
  };
  try {
    const started = process.hrtime.bigint();
    const result = await migrateIndexes();
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(result.built, false);
    assert.equal(reads, 1);
    assert.equal(builds, 0);
    assert.ok(ms < 250, `an unchanged start took ${ms.toFixed(1)} ms`);
  } finally {
    mongoose.connection.db.collection = spy;
    mongoose.Model.createIndexes = originalCreate;
    collection.findOne = originalFindOne;
  }
});

test('the app, loaded the way production loads it, registers every model file', () => {
  // A model that nothing requires would never get its indexes from the migration (it walks mongoose.models).
  // Run in a child so this file's own requires do not hide a missing one. No .env is read (dotenv is replaced),
  // and MONGO_URI points at a closed local port: nothing connects anywhere.
  const script = `
    const Module = require('module');
    const load = Module._load;
    Module._load = function (request, ...rest) { return request === 'dotenv' ? { config: () => ({}), parse: () => ({}) } : load.call(this, request, ...rest); };
    Object.assign(process.env, { NODE_ENV: 'test', MONGO_URI: 'mongodb://127.0.0.1:1/none', PUBLIC_APP_URL: 'https://warden.test' });
    delete process.env.VERCEL;
    require(${JSON.stringify(path.join(__dirname, '..', 'server.js'))});
    const names = require('mongoose').modelNames();
    process.stdout.write('NAMES:' + JSON.stringify(names));
    process.exit(0);
  `;
  const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
  const match = /NAMES:(\[.*\])/.exec(run.stdout);
  assert.ok(match, `child output: ${run.stdout.slice(0, 200)} ${run.stderr.slice(0, 200)}`);
  const loaded = JSON.parse(match[1]);
  const expected = modelFiles.map((file) => file.replace(/\.js$/, ''));
  const missing = expected.filter((name) => !loaded.includes(name));
  assert.deepEqual(missing, [], `models the app does not load at startup: ${missing.join(', ')}`);
});
