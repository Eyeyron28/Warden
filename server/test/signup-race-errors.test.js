// Run with: cd server && npm test
//
// (1) Parallel sign-ups for the SAME new address against a REAL local MongoDB (test/helpers/realMongo.js): the loser of
//     the race must get the same generic answer as any existing address, never the driver's E11000 text.
// (2) The error handler: a server-side failure is answered with one fixed message and a request id; the real error goes
//     to the log with no address or connection string in it; app-authored messages and 4xx are untouched.
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
const { errorHandler, GENERIC_SERVER_ERROR } = require('../middleware/errorHandler');
const User = require('../models/User');

const PASSWORD = 'Qx7!vTr29#mLpw';

let connected = { ok: false, reason: '' };
test.before(async () => {
  connected = await connectThrowaway('signup_race');
  if (connected.ok) await User.init();
});
test.after(disconnectThrowaway);

const it = (name, fn) =>
  test(name, async (context) => {
    if (!connected.ok) return context.skip(connected.reason);
    return fn(context);
  });

function handled(error) {
  const out = { status: null, body: null };
  const res = { statusCode: 200, status(code) { out.status = code; return this; }, json(body) { out.body = body; return this; } };
  errorHandler(error, { headers: {} }, res, () => {});
  return out;
}

it('parallel sign-ups for one new address all get the generic answer and exactly one account exists', async () => {
  await mongoose.connection.dropDatabase();
  await User.init();
  const email = `race-${Date.now()}@example.com`;
  const results = await Promise.all(Array.from({ length: 8 }, () => call(auth.signup, { body: { email, password: PASSWORD }, inviteChecked: true })));
  for (const out of results) {
    assert.equal(out.error, null, `unexpected error: ${out.error?.message}`);
    assert.equal(out.status, 200);
    assert.equal(out.json.message, 'If this email can be registered, a verification link has been sent.');
    assert.ok(out.json.recoveryKey);
    assert.deepEqual(Object.keys(out.json).sort(), ['message', 'recoveryKey']);
  }
  assert.equal(await User.countDocuments({ email }), 1);
});

it('a lost race (the database says duplicate key at create time) is answered as an existing address', async (context) => {
  await mongoose.connection.dropDatabase();
  await User.init();
  context.mock.method(User, 'create', async () => {
    throw Object.assign(new Error('E11000 duplicate key error collection: warden.users index: email_1 dup key: { email: "x@example.com" }'), { code: 11000 });
  });
  const out = await call(auth.signup, { body: { email: 'x@example.com', password: PASSWORD }, inviteChecked: true });
  assert.equal(out.error, null);
  assert.equal(out.status, 200);
  assert.deepEqual(Object.keys(out.json).sort(), ['message', 'recoveryKey']);
});

test('a forced 500 answers with the fixed message and a request id, and logs the real error without addresses', (context) => {
  const logged = [];
  context.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
  const out = handled(Object.assign(new Error('E11000 duplicate key error collection: warden.users index: email_1 dup key: { email: "victim@example.com" } at mongodb+srv://user:pw@cluster0.example.net/db'), { code: 11000 }));
  assert.equal(out.status, 500);
  assert.equal(out.body.error.message, GENERIC_SERVER_ERROR);
  assert.match(out.body.error.requestId, /^[0-9a-f]{12}$/);
  assert.ok(!JSON.stringify(out.body).includes('E11000'));
  assert.ok(!JSON.stringify(out.body).includes('victim'));
  assert.equal(logged.length, 1);
  assert.ok(logged[0].includes(out.body.error.requestId), 'the log line carries the same request id');
  assert.ok(logged[0].includes('E11000'), 'the real error is in the log');
  assert.ok(!logged[0].includes('victim@example.com'), 'but not the address');
  assert.ok(!logged[0].includes('user:pw'), 'nor the connection string');
});

test('every 5xx without the app’s own opt-in is replaced, including 502/503 from a library', (context) => {
  context.mock.method(console, 'error', () => {});
  for (const status of [500, 502, 503, 504]) {
    const out = handled(Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:27017'), { status }));
    assert.equal(out.body.error.message, GENERIC_SERVER_ERROR, String(status));
  }
});

test('app-authored 5xx text (expose) and every 4xx are unchanged', () => {
  const sendFailed = Object.assign(new Error('We couldn’t send the code email. Please try again shortly.'), { status: 503, expose: true });
  const shown = handled(sendFailed);
  assert.equal(shown.body.error.message, sendFailed.message);
  const bad = handled(Object.assign(new Error('Incorrect email or password.'), { status: 401 }));
  assert.equal(bad.body.error.message, 'Incorrect email or password.');
  assert.equal(bad.body.error.requestId, undefined);
});

test('every place that raises an app-authored 5xx marks it as exposed (so its message is not swallowed)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const files = ['controllers/account.controller.js', 'controllers/shares.controller.js', 'controllers/security.controller.js', 'controllers/passwordReset.controller.js', 'controllers/documents.controller.js', 'utils/folders.js', 'utils/otpChallenge.js', 'utils/shareGate.js', 'utils/emergency/service.js'];
  for (const file of files) assert.match(fs.readFileSync(path.join(root, file), 'utf8'), /expose/, file);
});
