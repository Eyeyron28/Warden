const test = require('node:test');
const assert = require('node:assert/strict');

for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']) delete process.env[name];
delete process.env.VERCEL;
process.env.NODE_ENV = 'test';

const { errorHandler, GENERIC_SERVER_ERROR } = require('../middleware/errorHandler');

function handled(error) {
  const out = { status: null, body: null };
  const res = { statusCode: 200, status(code) { out.status = code; return this; }, json(body) { out.body = body; return this; } };
  errorHandler(error, { headers: {} }, res, () => {});
  return out;
}

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
