// Run with: cd server && npm test
//
// The login lockout against a REAL local MongoDB (test/helpers/realMongo.js): the whole point is that it is atomic
// under parallel requests and identical for real and unknown addresses, which an in-memory fake cannot show.
// Skipped, with the reason, when no local MongoDB answers.
const test = require('node:test');
const assert = require('node:assert/strict');

for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']) delete process.env[name];
delete process.env.VERCEL;
process.env.NODE_ENV = 'test';
process.env.SIGNUP_MODE = 'open';

const { connectThrowaway, disconnectThrowaway, mongoose } = require('./helpers/realMongo');
const { call } = require('./helpers/fakeDb');

const emailPath = require.resolve('../utils/email');
const realEmail = require('../utils/email');
require.cache[emailPath].exports = { ...realEmail, sendEmail: async () => true };

const auth = require('../controllers/auth.controller');
const User = require('../models/User');
const LoginFailure = require('../models/LoginFailure');

const PASSWORD = 'Qx7!vTr29#mLpw';
const REAL = 'victim@example.com';
const UNKNOWN = 'nobody-here@example.com';

let connected = { ok: false, reason: '' };
test.before(async () => {
  connected = await connectThrowaway('login_lockout');
  if (!connected.ok) return;
  await User.init();
  await LoginFailure.init();
});
test.after(disconnectThrowaway);

// Skipped (with the reason) when no local MongoDB answered in `before`.
const it = (name, fn) =>
  test(name, async (context) => {
    if (!connected.ok) return context.skip(connected.reason);
    return fn(context);
  });

async function freshAccount() {
  await mongoose.connection.dropDatabase();
  await User.init();
  await LoginFailure.init();
  await call(auth.signup, { body: { email: REAL, password: PASSWORD }, inviteChecked: true });
  await User.updateOne({ email: REAL }, { $set: { emailVerified: true } });
}

// What a caller can see of an answer: status, body fields, headers. Nothing about the account.
const seen = (out) => ({
  status: out.error ? out.error.status : out.status,
  message: out.error ? out.error.message : null,
  locked: out.error?.locked ?? false,
  minutesRemaining: out.error?.minutesRemaining ?? null,
  headers: out.headers,
  otp: Boolean(out.json?.otpRequired),
});

const attempt = (email, password) => call(auth.unlock, { body: { email, password }, headers: {} });

async function expireLockFor(email) {
  const past = new Date(Date.now() - 1000);
  await LoginFailure.updateMany({}, { $set: { windowExpiresAt: past, lockedUntil: past, expireAt: past } });
  await User.updateOne({ email }, { $set: { lockedUntil: past, failedAttempts: 0 } });
}

it('20 parallel wrong passwords get exactly 3 checks, and the stored count stops at the cap', async () => {
  await freshAccount();
  const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => attempt(REAL, `wrong-password-${i}`)));
  // Three attempts were checked: two answered 401 and the third (the one that tripped the lock) answered "locked".
  // The other 17 arrived while the lock was on and were refused without their password being looked at.
  const wrong = answers.filter((out) => out.error?.status === 401);
  const locked = answers.filter((out) => out.error?.locked);
  assert.equal(wrong.length, 2, `${wrong.length} answered 401`);
  assert.equal(locked.length, 18);
  const stored = await LoginFailure.find({});
  assert.equal(stored.length, 1);
  assert.equal(stored[0].count, 3, 'the counter holds the limit, not the number of requests');
  assert.ok(stored[0].lockedUntil > new Date());
});

it('a real and an unknown address are indistinguishable after 1, 2, 3, 4 and 5 attempts', async () => {
  await freshAccount();
  const realSeen = [];
  const unknownSeen = [];
  for (let i = 0; i < 5; i += 1) {
    realSeen.push(seen(await attempt(REAL, `wrong-${i}`)));
    unknownSeen.push(seen(await attempt(UNKNOWN, `wrong-${i}`)));
  }
  assert.deepEqual(realSeen.map((s) => s.status), [401, 401, 403, 403, 403]);
  assert.deepEqual(unknownSeen, realSeen, 'same status, message, lock flag, minutes and headers at every step');
  assert.equal(realSeen[2].locked, true);
  assert.match(realSeen[3].message, /Too many failed attempts/);
});

it('a correct password during a lock is refused the same way for both', async () => {
  await freshAccount();
  for (let i = 0; i < 3; i += 1) {
    await attempt(REAL, `wrong-${i}`);
    await attempt(UNKNOWN, `wrong-${i}`);
  }
  const real = seen(await attempt(REAL, PASSWORD));
  const unknown = seen(await attempt(UNKNOWN, PASSWORD));
  assert.equal(real.status, 403);
  assert.equal(real.locked, true);
  assert.equal(real.otp, false);
  assert.deepEqual(unknown, real);
});

it('the lock expires, then the same address can log in again', async () => {
  await freshAccount();
  for (let i = 0; i < 3; i += 1) await attempt(REAL, `wrong-${i}`);
  assert.equal(seen(await attempt(REAL, PASSWORD)).locked, true);
  await expireLockFor(REAL);
  const out = await attempt(REAL, PASSWORD);
  assert.equal(out.error, null, 'password accepted after the lock ended');
  assert.equal(out.json?.otpRequired, true);
});

it('existing behavior for real users: two misses then the right password works, and clears the count', async () => {
  await freshAccount();
  await attempt(REAL, 'wrong-1');
  await attempt(REAL, 'wrong-2');
  const ok = await attempt(REAL, PASSWORD);
  assert.equal(ok.error, null);
  assert.equal(ok.json?.otpRequired, true);
  // The count was cleared by the success: two more misses are NOT yet a lock.
  assert.equal(seen(await attempt(REAL, 'wrong-3')).status, 401);
  assert.equal(seen(await attempt(REAL, 'wrong-4')).status, 401);
  assert.equal(seen(await attempt(REAL, 'wrong-5')).locked, true, 'the third miss locks, as before');
});

it('the counter holds an HMAC, never the address', async () => {
  await freshAccount();
  await attempt(UNKNOWN, 'wrong');
  const [row] = await LoginFailure.find({}).lean();
  assert.match(row.key, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(row).includes('nobody-here'));
});

// The same sequence, with the clock passed in, run against the REAL pipeline update.
it('window and lock follow the clock: reset after 5 minutes, lock for 5 minutes, then a fresh start', async () => {
  const { reserveLoginAttempt } = require('../utils/loginLimiter');
  await freshAccount();
  const t0 = new Date('2030-01-01T00:00:00Z');
  const at = (ms) => new Date(t0.getTime() + ms);
  const shape = (r) => [r.granted, r.locked];
  assert.deepEqual(shape(await reserveLoginAttempt('a@example.com', { now: at(0) })), [true, false]);
  assert.deepEqual(shape(await reserveLoginAttempt('a@example.com', { now: at(1000) })), [true, false]);
  // 5 minutes after the first miss the window has ended: counting starts over (the lone old miss is forgotten).
  assert.deepEqual(shape(await reserveLoginAttempt('a@example.com', { now: at(5 * 60 * 1000 + 1) })), [true, false]);
  assert.equal((await LoginFailure.findOne({}).lean()).count, 1);
  // Two more inside the new window: the third attempt in it locks.
  await reserveLoginAttempt('a@example.com', { now: at(5 * 60 * 1000 + 2000) });
  const locking = await reserveLoginAttempt('a@example.com', { now: at(5 * 60 * 1000 + 3000) });
  assert.deepEqual(shape(locking), [true, true]);
  assert.equal(locking.lockedUntil.getTime(), at(5 * 60 * 1000 + 3000 + 5 * 60 * 1000).getTime());
  // Refused while locked, even after the 5-minute window itself has ended (the lock is what counts).
  assert.deepEqual(shape(await reserveLoginAttempt('a@example.com', { now: at(10 * 60 * 1000) })), [false, true]);
  // Lock over: a clean slate.
  assert.deepEqual(shape(await reserveLoginAttempt('a@example.com', { now: at(10 * 60 * 1000 + 4000) })), [true, false]);
  assert.equal((await LoginFailure.findOne({}).lean()).count, 1);
});
