// Run with: cd server && npm test
//
// Request budgets of the signed-in pages. Measured with the real client against the real API (one visit, prefetch included):
//   Emergency status: the banner polls it every 60 s on EVERY page and the Emergency page every 30 s - on the old 60-per-hour
//   owner budget one open tab used the whole hour, and the resulting 429 also blocked the owner's real actions (deny, approve).
//   Trusted browsers: Settings reads them on every visit; the old strict budget (10 per hour per account, 20 per hour per
//   connection) answered 429 from the 11th visit.
// So the READS have their own, larger budget, and the actions keep the strict one. This runs the REAL app (every middleware)
// on a LOCAL throwaway MongoDB and is skipped, with the reason, without one. No .env is read, no mail is sent.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');

const { startLiveApp } = require('./helpers/liveApp');

let live = { ok: false, reason: '' };
let base = '';
let server = null;
let token = '';

test.before(async () => {
  live = await startLiveApp('rate_headroom');
  if (!live.ok) return;
  server = http.createServer(live.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const User = live.mongoose.models.User;
  const { buildAccountFields } = require('../utils/accountCreate');
  const { createSession } = require('../utils/sessionStore');
  const { fields } = buildAccountFields('Qx7!vTr29#mLpw');
  const user = await User.create({ email: 'headroom@example.com', emailVerified: true, ...fields });
  token = await createSession(user._id, crypto.randomBytes(32));
});
test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (live.ok) await live.stop();
});
const it = (name, fn) =>
  test(name, async (context) => {
    if (!live.ok) return context.skip(live.reason);
    return fn(context);
  });

const clear = () => live.mongoose.models.RateLimit.deleteMany({});
async function call(method, path, json) {
  const response = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : undefined,
  });
  await response.text();
  return response.status;
}
async function many(count, method, path, json) {
  const statuses = [];
  for (let i = 0; i < count; i += 1) statuses.push(await call(method, path, json)); // eslint-disable-line no-await-in-loop
  return statuses;
}

it('an open tab polling the emergency status every minute for hours never reaches a 429, and does not use up the actions', async () => {
  await clear();
  // 3 hours of the banner (60/h) plus the Emergency page open (120/h) is 360 calls; one hour of both is 180.
  const statuses = await many(180, 'GET', '/api/emergency/status');
  assert.equal(statuses.filter((s) => s === 429).length, 0);
  assert.ok(statuses.every((s) => s === 200));
  // The owner's actions have their own, untouched budget: a deny / approve is still possible after an hour of polling.
  const action = await call('POST', '/api/emergency/challenge', { action: 'not-an-action' });
  assert.notEqual(action, 429);
});

it('the reads are still bounded (a runaway client is stopped), and the actions keep the strict 60 per hour', async () => {
  await clear();
  const reads = await many(601, 'GET', '/api/emergency/session-info');
  assert.equal(reads.at(-1), 429, 'the 601st read in an hour is refused');
  assert.ok(reads.slice(0, 600).every((s) => s !== 429));
  await clear();
  const actions = await many(61, 'POST', '/api/emergency/challenge', { action: 'not-an-action' });
  assert.ok(actions.slice(0, 60).every((s) => s !== 429));
  assert.equal(actions[60], 429, 'the 61st action in an hour is refused');
});

it('Settings can be opened as often as a person likes, while removing trusted browsers stays strictly limited', async () => {
  await clear();
  const reads = await many(40, 'GET', '/api/account/trusted-devices');
  assert.ok(reads.every((s) => s === 200), `got ${[...new Set(reads)]}`);
  await clear();
  const removals = await many(11, 'DELETE', '/api/account/trusted-devices/000000000000000000000000');
  assert.ok(removals.slice(0, 10).every((s) => s !== 429));
  assert.equal(removals[10], 429, 'the 11th removal in an hour is refused');
});

it('the new read routes still need a session', async () => {
  await clear();
  for (const path of ['/api/emergency/status', '/api/emergency/session-info', '/api/emergency/folders', '/api/account/trusted-devices']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 401, path);
  }
});
