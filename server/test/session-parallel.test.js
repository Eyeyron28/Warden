const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
delete process.env.VERCEL;

const { connectThrowaway, disconnectThrowaway, mongoose } = require('./helpers/realMongo');
const Session = require('../models/Session');
const Device = require('../models/Device');
const store = require('../utils/sessionStore');

const realGetSession = store.getSession;
let afterLookup = null;
store.getSession = async (token) => {
  const found = await realGetSession(token);
  if (afterLookup) await afterLookup(token);
  return found;
};
const requireSession = require('../middleware/requireSession');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const dek = crypto.randomBytes(32);

let connected = { ok: false, reason: '' };
test.before(async () => {
  connected = await connectThrowaway('session_parallel');
  if (connected.ok) await Promise.all([Session.createIndexes(), Device.createIndexes()]);
});
test.after(disconnectThrowaway);
const it = (name, fn) =>
  test(name, async (context) => {
    if (!connected.ok) return context.skip(connected.reason);
    afterLookup = null;
    return fn(context);
  });

async function fresh({ lastSeenAgoMs = 10 * MIN } = {}) {
  const userId = new mongoose.Types.ObjectId();
  const device = await Device.create({ userId, deviceIdHash: crypto.randomBytes(8).toString('hex'), label: 'Test on Test', lastSeenAt: new Date(Date.now() - lastSeenAgoMs) });
  const token = await store.createSession(userId, dek, { deviceId: device._id });
  const hash = crypto.createHash('sha256').update(token.split('.')[0]).digest('hex');
  return { userId, device, token, hash };
}

function call(token) {
  return new Promise((resolve) => {
    const req = { headers: { authorization: `Bearer ${token}`, 'x-vercel-ip-country': 'PH' }, method: 'GET', originalUrl: '/api/documents', path: '/api/documents' };
    requireSession(req, {}, (err) => resolve({ err, req }));
  });
}

const row = (hash) => Session.findOne({ sessionIdHash: hash }).lean();
const seen = async (device) => (await Device.findById(device._id).lean()).lastSeenAt.getTime();

it('(d) the idle timeout still slides: a use moves the end to 30 minutes from now', async () => {
  const { token, hash } = await fresh();
  await Session.updateOne({ sessionIdHash: hash }, { $set: { expiresAt: new Date(Date.now() + 1 * MIN) } });
  const { err, req } = await call(token);
  assert.equal(err, undefined);
  assert.ok(req.userId && req.dek.equals(dek));
  const left = (await row(hash)).expiresAt.getTime() - Date.now();
  assert.ok(left > 29 * MIN && left <= 30 * MIN + 2000, `slid to ${Math.round(left / 1000)} s from now`);
});

it('(d) the device is still noted, and still at most once a minute', async () => {
  const { token, device } = await fresh({ lastSeenAgoMs: 10 * MIN });
  const before = await seen(device);
  assert.equal((await call(token)).err, undefined);
  const after = await seen(device);
  assert.ok(after > before && Date.now() - after < 5000, 'lastSeenAt moved to now');
  assert.equal((await Device.findById(device._id).lean()).lastCountry, 'PH');
  assert.equal((await call(token)).err, undefined);
  assert.equal(await seen(device), after);
});

it('a failing device write never fails the request (as before)', async (context) => {
  const { token, hash } = await fresh();
  context.mock.method(Device, 'updateOne', async () => { throw new Error('device write failed'); });
  const { err } = await call(token);
  assert.equal(err, undefined);
  assert.ok(await row(hash), 'the session is still there and slid');
});

it('(b) the sliding update cannot push a session past its absolute 12 hours', async () => {
  const { token, hash } = await fresh();
  const createdAt = new Date(Date.now() - (12 * HOUR - 5 * MIN));
  await Session.updateOne({ sessionIdHash: hash }, { $set: { createdAt, expiresAt: new Date(Date.now() + 10 * MIN) } });
  assert.equal((await call(token)).err, undefined);
  const end = (await row(hash)).expiresAt.getTime();
  assert.ok(end <= createdAt.getTime() + 12 * HOUR + 1, 'never past createdAt + 12 h');
  assert.ok(end < Date.now() + 6 * MIN, 'it slid to the absolute end, not to 30 minutes from now');
  await Session.updateOne({ sessionIdHash: hash }, { $set: { createdAt: new Date(Date.now() - 12 * HOUR - MIN), expiresAt: new Date(Date.now() + 20 * MIN) } });
  const refused = await call(token);
  assert.equal(refused.err.status, 401);
  assert.equal(await row(hash), null);
});

it('(b) an Emergency Access session also cannot slide past its own 4-hour end', async () => {
  const userId = new mongoose.Types.ObjectId();
  const token = await store.createSession(userId, dek, { emergency: { accessId: new mongoose.Types.ObjectId(), requestId: new mongoose.Types.ObjectId(), scopeMode: 'all', absoluteMs: 4 * HOUR } });
  const hash = crypto.createHash('sha256').update(token.split('.')[0]).digest('hex');
  const end = new Date(Date.now() + 3 * MIN);
  await Session.updateOne({ sessionIdHash: hash }, { $set: { absoluteExpiresAt: end, expiresAt: new Date(Date.now() + 2 * MIN) } });
  const result = await call(token);
  const slid = (await row(hash))?.expiresAt.getTime();
  assert.ok(slid !== undefined, `the session row exists (${result.err?.message})`);
  assert.ok(slid <= end.getTime(), 'not past the stored absolute end');
  if (!result.err) assert.ok(slid > Date.now(), 'and it did slide up to that end');
});

it('(c) an expired session is refused exactly like an unknown token, and nothing is written for it', async () => {
  const { token, hash, device } = await fresh();
  await Session.updateOne({ sessionIdHash: hash }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const before = await seen(device);
  const expired = await call(token);
  const unknown = await call(`${crypto.randomBytes(32).toString('hex')}.${crypto.randomBytes(32).toString('hex')}`);
  const malformed = await call('nonsense');
  for (const result of [expired, unknown, malformed]) {
    assert.equal(result.err.status, 401);
    assert.equal(result.err.code, 'SESSION_INVALID');
  }
  assert.equal(expired.err.message, unknown.err.message, 'no difference between expired and never existed');
  assert.equal(await row(hash), null, 'the expired row is gone, not slid');
  assert.equal(await seen(device), before, 'the device was not touched');
});

it('(a) a revoked session cannot be used, touched or brought back', async () => {
  const { token, hash, device } = await fresh();
  await store.destroySession(token);
  const before = await seen(device);
  const result = await call(token);
  assert.equal(result.err.status, 401);
  assert.equal(await Session.countDocuments({ sessionIdHash: hash }), 0, 'no upsert: still gone');
  assert.equal(await seen(device), before, 'the device was not touched');
});

it('(a) a revoke that lands between the lookup and the writes is not undone by them', async () => {
  const { token, hash, userId } = await fresh();
  afterLookup = async (t) => { await store.destroySession(t); };
  const result = await call(token);
  assert.equal(result.err, undefined);
  assert.equal(await Session.countDocuments({ sessionIdHash: hash }), 0, 'the slide did not recreate the session');
  assert.equal(await Session.countDocuments({ userId }), 0);
  afterLookup = null;
  assert.equal((await call(token)).err.status, 401);
});

it('(a) signing a device out, or all other sessions, ends them for good', async () => {
  const one = await fresh();
  assert.equal((await store.destroySessionsForDevice(one.userId, one.device._id)), 1);
  afterLookup = async () => { await store.destroySessionsForDevice(one.userId, one.device._id); };
  const two = await fresh();
  afterLookup = async () => { await store.destroySessionsForDevice(two.userId, two.device._id); };
  await call(two.token);
  assert.equal(await Session.countDocuments({ userId: two.userId }), 0);
  assert.equal((await call(one.token)).err.status, 401);
});

it('the middleware source still slides and notes together, and never upserts', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const middleware = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'requireSession.js'), 'utf8');
  assert.match(middleware, /Promise\.all\(\[\s*refreshSession\(token, \{ absoluteExpiresAt: session\.absoluteExpiresAt \|\| null \}\)/);
  const storeSource = fs.readFileSync(path.join(__dirname, '..', 'utils', 'sessionStore.js'), 'utf8');
  assert.doesNotMatch(storeSource, /upsert/);
  const identity = fs.readFileSync(path.join(__dirname, '..', 'utils', 'deviceIdentity.js'), 'utf8');
  assert.doesNotMatch(identity, /upsert/);
});
