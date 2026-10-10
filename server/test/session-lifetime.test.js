// Run with: cd server && npm test
//
// F10: a session ends after 30 minutes without activity AND after SESSION_ABSOLUTE_HOURS (default 12) however busy it is.
// Emergency sessions keep their own 4-hour cap. The clock is controlled (node:test mock timers), so "12 hours" takes no time.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
delete process.env.VERCEL;
const db = require('./helpers/fakeDb');
const world = db.createWorld();
db.installModels(world);

const store = require('../utils/sessionStore');
const requireSession = require('../middleware/requireSession');

const START = Date.parse('2030-06-01T08:00:00Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const dek = crypto.randomBytes(32);
const userId = db.oid();

function clock(context) {
  context.mock.timers.enable({ apis: ['Date'], now: START });
  return (ms) => context.mock.timers.setTime(START + ms);
}

/** What requireSession does for one request, minus the HTTP: resolve the token, then slide it. */
async function use(token) {
  const session = await store.getSession(token);
  if (!session) return null;
  await store.refreshSession(token, { absoluteExpiresAt: session.absoluteExpiresAt });
  return session;
}

function withHours(value, fn) {
  const saved = process.env.SESSION_ABSOLUTE_HOURS;
  if (value === undefined) delete process.env.SESSION_ABSOLUTE_HOURS; else process.env.SESSION_ABSOLUTE_HOURS = value;
  return Promise.resolve(fn()).finally(() => {
    if (saved === undefined) delete process.env.SESSION_ABSOLUTE_HOURS; else process.env.SESSION_ABSOLUTE_HOURS = saved;
  });
}

test('a busy session still ends 12 hours after it was created', async (context) => {
  world.tables.sessions.length = 0;
  const at = clock(context);
  await withHours(undefined, async () => {
    const token = await store.createSession(userId, dek);
    let last = 0;
    // Active every 25 minutes (well inside the idle limit) for 11h50m: always valid.
    for (let t = 25 * MIN; t <= 11 * HOUR + 50 * MIN; t += 25 * MIN) {
      at(t);
      assert.ok(await use(token), `still valid at ${t / MIN} minutes`);
      last = t;
    }
    assert.ok(last > 11 * HOUR);
    // Just before the 12-hour mark it still works...
    at(11 * HOUR + 59 * MIN);
    assert.ok(await use(token));
    // ...and one minute after it does not, even though the last request was a minute ago.
    at(12 * HOUR + 1 * MIN);
    assert.equal(await store.getSession(token), null);
    assert.equal(world.tables.sessions.length, 0, 'the row is removed too');
  });
});

test('the sliding refresh never pushes expiresAt past the absolute end', async (context) => {
  world.tables.sessions.length = 0;
  const at = clock(context);
  await withHours('1', async () => {
    const token = await store.createSession(userId, dek);
    at(20 * MIN);
    assert.ok(await use(token));
    at(45 * MIN);
    assert.ok(await use(token));
    const row = world.tables.sessions[0];
    assert.equal(row.expiresAt.getTime(), START + 1 * HOUR, 'capped at 1 hour from creation, not 45 + 30 minutes');
  });
});

test('the 30-minute idle limit is unchanged', async (context) => {
  world.tables.sessions.length = 0;
  const at = clock(context);
  await withHours(undefined, async () => {
    const token = await store.createSession(userId, dek);
    at(29 * MIN);
    assert.ok(await use(token));
    at(29 * MIN + 31 * MIN); // 31 minutes of silence
    assert.equal(await store.getSession(token), null);
  });
});

test('SESSION_ABSOLUTE_HOURS is read from the environment; a bad value falls back to 12', async () => {
  await withHours('3', () => assert.equal(store.sessionAbsoluteHours(), 3));
  await withHours('0', () => assert.equal(store.sessionAbsoluteHours(), 12));
  await withHours('abc', () => assert.equal(store.sessionAbsoluteHours(), 12));
  await withHours('500', () => assert.equal(store.sessionAbsoluteHours(), 12));
  await withHours('', () => assert.equal(store.sessionAbsoluteHours(), 12));
  await withHours(undefined, () => assert.equal(store.sessionAbsoluteHours(), 12));
});

test('emergency sessions keep their 4-hour cap, and a shorter SESSION_ABSOLUTE_HOURS still wins', async (context) => {
  world.tables.sessions.length = 0;
  const at = clock(context);
  const emergency = { accessId: db.oid(), requestId: db.oid(), scopeMode: 'all', absoluteMs: 4 * HOUR };
  await withHours(undefined, async () => {
    const token = await store.createSession(userId, dek, { emergency });
    for (let t = 25 * MIN; t <= 3 * HOUR + 50 * MIN; t += 25 * MIN) {
      at(t);
      assert.ok(await use(token), `valid at ${t / MIN} minutes`);
    }
    at(4 * HOUR + 1 * MIN);
    assert.equal(await store.getSession(token), null, 'ended at 4 hours although it was busy');
  });
  world.tables.sessions.length = 0;
  at(0);
  await withHours('1', async () => {
    const token = await store.createSession(userId, dek, { emergency });
    at(25 * MIN);
    assert.ok(await use(token));
    at(50 * MIN);
    assert.ok(await use(token));
    at(HOUR + 5 * MIN);
    assert.equal(await store.getSession(token), null, 'the 1-hour absolute limit applies to emergency sessions too');
  });
});

test('through requireSession an expired session is SESSION_INVALID (the client shows "Your session expired. Sign in again.")', async (context) => {
  world.tables.sessions.length = 0;
  const at = clock(context);
  await withHours(undefined, async () => {
    const token = await store.createSession(userId, dek);
    const run = () => new Promise((resolve) => requireSession({ headers: { authorization: `Bearer ${token}` }, method: 'GET', baseUrl: '/api/documents', path: '/', ip: '203.0.113.9', cookies: {} }, {}, (err) => resolve(err || null)));
    for (let t = 25 * MIN; t <= 11 * HOUR + 50 * MIN; t += 25 * MIN) {
      at(t);
      assert.equal(await run(), null);
    }
    at(12 * HOUR + 2 * MIN);
    const err = await run();
    assert.equal(err.status, 401);
    assert.equal(err.code, 'SESSION_INVALID');
  });
});
