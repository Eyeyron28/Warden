// Run with: cd server && npm test
//
// Server-side speed work that must not quietly regress (each item names what was measured before the change):
//   - indexes are built once per set of declared indexes (a marker), not by Mongoose on every cold start (52 createIndex
//     commands per start were measured); the vault list, Photos, the expiry list and "Frequently used" each have an index that
//     serves them (explain showed an in-memory SORT and full scans of the account's documents / events);
//   - an ordinary request reads the session once, then slides it and notes the device TOGETHER (two writes in a row before);
//   - the startup checks of config/db.js ask together.
// The index tests use a LOCAL throwaway MongoDB (test/helpers/realMongo.js) and are skipped, with the reason, without one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
delete process.env.VERCEL;

const { connectThrowaway, disconnectThrowaway, mongoose } = require('./helpers/realMongo');

let connected = { ok: false, reason: '' };
test.before(async () => {
  connected = await connectThrowaway('perf_server');
});
test.after(disconnectThrowaway);
const it = (name, fn) =>
  test(name, async (context) => {
    if (!connected.ok) return context.skip(connected.reason);
    return fn(context);
  });

const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function planOf(explained) {
  const stages = [];
  let node = explained.queryPlanner.winningPlan;
  while (node) {
    stages.push(node.stage + (node.indexName ? `(${node.indexName})` : ''));
    node = node.inputStage || (node.inputStages && node.inputStages[0]);
  }
  return stages;
}

it('indexes are built once per set of declared indexes: the first start builds and writes a marker, later starts only read it', async (context) => {
  require('../models/User');
  require('../models/Document');
  require('../models/AuditEvent');
  const { migrateIndexes } = require('../utils/migrateIndexes');
  await mongoose.connection.dropDatabase();

  const first = await migrateIndexes();
  assert.equal(first.built, true);
  assert.match(first.id, /^indexes-[0-9a-f]{16}$/);
  const built = (await mongoose.connection.db.collection('users').indexes()).map((index) => index.name);
  assert.ok(built.includes('email_1'), 'the unique email index exists');

  // a second start: one marker read, no createIndexes at all
  const spy = context.mock.method(mongoose.Model, 'createIndexes', async () => {});
  const second = await migrateIndexes();
  assert.equal(second.built, false);
  assert.equal(second.id, first.id);
  assert.equal(spy.mock.callCount(), 0);
});

it('a changed index definition changes the marker, so the next start builds it', async () => {
  const { indexSignature } = require('../utils/migrateIndexes');
  const User = require('../models/User');
  const before = indexSignature([User]);
  User.schema.index({ zzTestOnly: 1 });
  try {
    assert.notEqual(indexSignature([User]), before);
  } finally {
    User.schema._indexes = User.schema._indexes.filter(([fields]) => !('zzTestOnly' in fields));
  }
  assert.equal(indexSignature([User]), before);
});

it('Mongoose no longer builds indexes by itself at start (config/db turns autoIndex off, set before any model exists)', () => {
  assert.match(source('config/db.js'), /mongoose\.set\('autoIndex', false\)/);
  assert.match(source('config/db.js'), /migrateIndexes/);
  assert.match(source('config/db.js'), /Promise\.allSettled\(steps\.map/, 'the startup checks ask together');
  // the settings really are in force once the file is loaded
  require('../config/db');
  assert.equal(mongoose.get('autoIndex'), false);
});

it('the vault list, Photos, the expiry list and "Frequently used" are each served by an index, with no in-memory sort', async () => {
  const Document = require('../models/Document');
  const AuditEvent = require('../models/AuditEvent');
  const { migrateIndexes } = require('../utils/migrateIndexes');
  await mongoose.connection.dropDatabase();
  await migrateIndexes();
  const userId = new mongoose.Types.ObjectId();
  const docs = Array.from({ length: 300 }, (_, i) => ({
    userId, filename: `f${i}.txt`, mimeType: 'text/plain', encryptedBlob: Buffer.from('x'), iv: 'a', authTag: 'b', checksum: `c${i}`, folder: 'root', originDevice: 'pc',
    deletedAt: null, createdAt: new Date(Date.now() - i * 1000), sniffedType: i % 3 ? 'none' : 'png', docExpiresAt: i % 10 ? null : new Date(),
  }));
  await Document.collection.insertMany(docs);
  await AuditEvent.collection.insertMany(Array.from({ length: 300 }, (_, i) => ({ userId, seq: i + 1, type: i % 2 ? 'view' : 'login', targetId: `t${i % 7}`, at: new Date(), expiresAt: new Date(Date.now() + 1e9) })));

  const list = await Document.collection.find({ userId, deletedAt: null }).sort({ createdAt: -1 }).explain('executionStats');
  assert.ok(!planOf(list).includes('SORT'), `the list needs no in-memory sort: ${planOf(list)}`);
  assert.ok(planOf(list).some((stage) => stage.startsWith('IXSCAN(userId_1_deletedAt_1_createdAt_-1)')), planOf(list).join('<'));

  const photos = await Document.collection.find({ userId, deletedAt: null, sniffedType: { $in: ['png', 'jpeg'] } }).explain('executionStats');
  assert.equal(photos.executionStats.totalDocsExamined, photos.executionStats.nReturned, 'Photos reads only the photos');

  const expiring = await Document.collection.find({ userId, deletedAt: null, docExpiresAt: { $ne: null } }).explain('executionStats');
  assert.ok(planOf(expiring).some((stage) => /IXSCAN\(userId_1_deletedAt_1_docExpiresAt_1\)/.test(stage)), planOf(expiring).join('<'));

  const views = await AuditEvent.collection.find({ userId, type: 'view', at: { $gte: new Date(Date.now() - 864e5) } }).explain('executionStats');
  assert.equal(views.executionStats.totalDocsExamined, views.executionStats.nReturned, '"Frequently used" reads only the view events');
});

it('"Frequently used" counts inside MongoDB and returns the same answer', async () => {
  const Document = require('../models/Document');
  const AuditEvent = require('../models/AuditEvent');
  const { frequentFor } = require('../controllers/insights.controller');
  await mongoose.connection.dropDatabase();
  const userId = new mongoose.Types.ObjectId();
  const mk = (name, extra = {}) => Document.collection.insertOne({ userId, filename: name, mimeType: 'x', encryptedBlob: Buffer.from('x'), iv: 'a', authTag: 'b', checksum: name, folder: 'root', originDevice: 'pc', deletedAt: null, createdAt: new Date(), viewCount: 0, ...extra });
  const popular = (await mk('popular.pdf')).insertedId;
  const middling = (await mk('middling.pdf')).insertedId;
  const trashed = (await mk('trashed.pdf', { deletedAt: new Date() })).insertedId;
  const event = (id, n, at = new Date()) => AuditEvent.collection.insertMany(Array.from({ length: n }, (_, i) => ({ userId, seq: Math.floor(Math.random() * 1e9), type: 'view', targetId: String(id), at, expiresAt: new Date(Date.now() + 1e9), i })));
  await event(popular, 5);
  await event(middling, 2);
  await event(trashed, 9);
  await event(new mongoose.Types.ObjectId(), 4); // a deleted file
  await event(popular, 3, new Date(Date.now() - 40 * 864e5)); // outside the 30-day window
  const alone = await frequentFor(userId, null); // the "Frequently used" endpoint: asks only for the documents it needs
  assert.deepEqual(alone.map((row) => [row.filename, row.opens]), [['popular.pdf', 5], ['middling.pdf', 2]]);
  const all = await Document.find({ userId, deletedAt: null }).select('filename folder viewCount downloadCount lastOpenedAt createdAt');
  assert.deepEqual((await frequentFor(userId, all)).map((row) => [row.filename, row.opens]), [['popular.pdf', 5], ['middling.pdf', 2]], 'and Overview, which already holds the documents, agrees');
});

test('an ordinary request slides the session and notes the device TOGETHER', async () => {
  const sessionStorePath = require.resolve('../utils/sessionStore');
  const devicePath = require.resolve('../utils/deviceIdentity');
  const savedStore = require.cache[sessionStorePath];
  const savedDevice = require.cache[devicePath];
  const log = [];
  const slow = (name) => async () => {
    log.push(`${name} start`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    log.push(`${name} end`);
  };
  require.cache[sessionStorePath] = { id: sessionStorePath, filename: sessionStorePath, loaded: true, exports: { getSession: async () => ({ userId: 'u', dek: Buffer.alloc(32), deviceId: 'd', sessionIdHash: 'h', absoluteExpiresAt: null, emergency: null }), refreshSession: slow('refresh') } };
  require.cache[devicePath] = { id: devicePath, filename: devicePath, loaded: true, exports: { touchDevice: slow('touch') } };
  delete require.cache[require.resolve('../middleware/requireSession')];
  try {
    const requireSession = require('../middleware/requireSession');
    const started = Date.now();
    await new Promise((resolve, reject) => requireSession({ headers: { authorization: `Bearer ${'a'.repeat(10)}.${'b'.repeat(10)}` }, method: 'GET', baseUrl: '/api/x', path: '/' }, {}, (err) => (err ? reject(err) : resolve())));
    assert.deepEqual(log.slice(0, 2).sort(), ['refresh start', 'touch start'], `both start before either ends: ${log.join(', ')}`);
    assert.ok(Date.now() - started < 55, 'about one wait, not two in a row');
  } finally {
    require.cache[sessionStorePath] = savedStore;
    require.cache[devicePath] = savedDevice;
    delete require.cache[require.resolve('../middleware/requireSession')];
  }
});

test('a failing device note never fails the request', async () => {
  const sessionStorePath = require.resolve('../utils/sessionStore');
  const devicePath = require.resolve('../utils/deviceIdentity');
  const savedStore = require.cache[sessionStorePath];
  const savedDevice = require.cache[devicePath];
  require.cache[sessionStorePath] = { id: sessionStorePath, filename: sessionStorePath, loaded: true, exports: { getSession: async () => ({ userId: 'u', dek: Buffer.alloc(32), deviceId: 'd', sessionIdHash: 'h', absoluteExpiresAt: null, emergency: null }), refreshSession: async () => {} } };
  require.cache[devicePath] = { id: devicePath, filename: devicePath, loaded: true, exports: { touchDevice: async () => { throw new Error('database hiccup'); } } };
  delete require.cache[require.resolve('../middleware/requireSession')];
  try {
    const requireSession = require('../middleware/requireSession');
    const error = await new Promise((resolve) => requireSession({ headers: { authorization: `Bearer ${'a'.repeat(10)}.${'b'.repeat(10)}` }, method: 'GET', baseUrl: '/api/x', path: '/' }, {}, (err) => resolve(err || null)));
    assert.equal(error, null);
  } finally {
    require.cache[sessionStorePath] = savedStore;
    require.cache[devicePath] = savedDevice;
    delete require.cache[require.resolve('../middleware/requireSession')];
  }
});
