// Run with: cd server && npm test
//
// Signup, resend-verification and password-reset start must not reveal whether an address has an account - not by the
// body, not by the status, and not by how long they take. The mailer takes a fixed 40 ms here (a stand-in for SMTP), the
// models are the in-memory fakes, and the real scrypt/key work runs.
//
// The timing assertion is deliberately generous so it is not flaky on a busy machine: the MEDIANS of 5 interleaved
// runs per path may differ by at most 25 % (or 25 ms, whichever is larger). The gaps this guards against were far
// outside that - a new address took about 8x as long as an existing one on signup, and a resend that sent nothing
// answered at once while a real one waited for the mailer.
const test = require('node:test');
const assert = require('node:assert/strict');

for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']) delete process.env[name];
delete process.env.VERCEL;
process.env.NODE_ENV = 'test';
process.env.SIGNUP_MODE = 'open';

const db = require('./helpers/fakeDb');
const world = db.createWorld();
db.installModels(world);
db.installMailer(world);
db.installRateLimit();
world.sendDelayMs = 40;

const auth = require('../controllers/auth.controller');
const reset = require('../controllers/passwordReset.controller');
const { call } = db;

const PASSWORD = 'Qx7!vTr29#mLpw';
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const timed = async (fn) => {
  const started = process.hrtime.bigint();
  const out = await fn();
  return { out, ms: Number(process.hrtime.bigint() - started) / 1e6 };
};
const answerOf = (out) => (out.error ? { status: out.error.status, message: out.error.message } : { status: out.status, message: out.json.message, keys: Object.keys(out.json).sort() });

function assertSimilar(label, a, b) {
  const ma = median(a);
  const mb = median(b);
  // 25 ms floor: setTimeout on Windows rounds to ~15.6 ms steps, which alone can move a 40 ms wait by 16 ms.
  const allowed = Math.max(25, 0.25 * Math.max(ma, mb));
  assert.ok(Math.abs(ma - mb) <= allowed, `${label}: medians ${ma.toFixed(0)} ms vs ${mb.toFixed(0)} ms differ by more than ${allowed.toFixed(0)} ms (${a.map((x) => x.toFixed(0))} / ${b.map((x) => x.toFixed(0))})`);
}

const addUser = (email, extra = {}) => {
  const user = { _id: db.oid(), email, emailVerified: true, save: async () => {}, ...extra };
  world.tables.users.push(user);
  return user;
};

test('signup: an existing address and a new one answer alike and take alike', async () => {
  addUser('taken@example.com');
  const fresh = [];
  const taken = [];
  let freshAnswer;
  let takenAnswer;
  for (let i = 0; i < 5; i += 1) {
    const a = await timed(() => call(auth.signup, { body: { email: `new-${i}@example.com`, password: PASSWORD }, inviteChecked: true }));
    const b = await timed(() => call(auth.signup, { body: { email: 'taken@example.com', password: PASSWORD }, inviteChecked: true }));
    fresh.push(a.ms);
    taken.push(b.ms);
    freshAnswer = answerOf(a.out);
    takenAnswer = answerOf(b.out);
  }
  assert.deepEqual(freshAnswer, takenAnswer, 'same status, message and body fields (recoveryKey included)');
  assert.equal(freshAnswer.status, 200);
  assertSimilar('signup', fresh, taken);
});

test('resend-verification: an unverified account, a verified one and an unknown address answer alike and take alike', async () => {
  // Some real sends first, so the look-alike's learned time has settled (as on any server that has been sending codes).
  for (let i = 0; i < 8; i += 1) {
    addUser(`warm-${i}@example.com`, { emailVerified: false });
    await call(auth.resendVerification, { body: { email: `warm-${i}@example.com` } });
  }

  const real = [];
  const none = [];
  let realAnswer;
  let noneAnswer;
  for (let i = 0; i < 5; i += 1) {
    addUser(`pending-${i}@example.com`, { emailVerified: false });
    const a = await timed(() => call(auth.resendVerification, { body: { email: `pending-${i}@example.com` } }));
    const b = await timed(() => call(auth.resendVerification, { body: { email: `ghost-${i}@example.com` } }));
    real.push(a.ms);
    none.push(b.ms);
    realAnswer = answerOf(a.out);
    noneAnswer = answerOf(b.out);
  }
  assert.deepEqual(realAnswer, noneAnswer);
  assertSimilar('resend (unknown address)', real, none);

  addUser('done@example.com', { emailVerified: true });
  const verified = [];
  for (let i = 0; i < 5; i += 1) verified.push((await timed(() => call(auth.resendVerification, { body: { email: 'done@example.com' } }))).ms);
  assertSimilar('resend (already verified)', real, verified);
});

test('password-reset start: a real account and an unknown address answer alike and take alike', async () => {
  // Warm the look-alike with some real sends.
  for (let i = 0; i < 8; i += 1) {
    addUser(`warm-reset-${i}@example.com`);
    await call(reset.startReset, { body: { email: `warm-reset-${i}@example.com` } });
  }

  const real = [];
  const none = [];
  let realAnswer;
  let noneAnswer;
  for (let i = 0; i < 5; i += 1) {
    addUser(`reset-${i}@example.com`);
    const a = await timed(() => call(reset.startReset, { body: { email: `reset-${i}@example.com` } }));
    const b = await timed(() => call(reset.startReset, { body: { email: `nobody-${i}@example.com` } }));
    real.push(a.ms);
    none.push(b.ms);
    realAnswer = Object.keys(a.out.json).sort();
    noneAnswer = Object.keys(b.out.json).sort();
    assert.equal(a.out.status, b.out.status);
    assert.equal(a.out.json.message, b.out.json.message);
  }
  assert.deepEqual(realAnswer, noneAnswer);
  assertSimilar('reset start', real, none);
});
