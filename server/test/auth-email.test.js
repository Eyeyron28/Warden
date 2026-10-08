// Run with: cd server && npm test   (Node's built-in test runner, no deps)
//
// Controller-level tests for the email address checks on signup,
// resend-verification and forgot-password. The User model and the mailer
// are replaced with recording fakes BEFORE the controller is loaded, so
// each test can assert exactly what was looked up, created or mailed - for
// a hostile address that has to be nothing at all.
const test = require('node:test');
const assert = require('node:assert/strict');

for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']) delete process.env[name];
process.env.SIGNUP_MODE = 'open';

const calls = { findOne: [], create: [], mails: [] };
let existingUser = null; // what the fake User.findOne resolves with

function stub(modulePath, exportsObject) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObject };
}

stub('../models/User', {
  findOne: async (query) => {
    calls.findOne.push(query);
    return existingUser;
  },
  create: async (doc) => {
    calls.create.push(doc);
    return doc;
  },
});

const realEmail = require('../utils/email');
stub('../utils/email', {
  ...realEmail,
  sendEmail: async (message) => {
    calls.mails.push(message);
    return true;
  },
});

const { signup, resendVerification } = require('../controllers/auth.controller');

const PASSWORD = 'Tk9$Lantern-Orbit%57';

function reset(user = null) {
  calls.findOne.length = 0;
  calls.create.length = 0;
  calls.mails.length = 0;
  existingUser = user;
}

// Runs an express handler against a fake request and reports what it did.
async function run(handler, body) {
  const result = { status: null, json: null, error: null };
  const res = {
    status(code) {
      result.status = code;
      return this;
    },
    json(payload) {
      result.json = payload;
      return this;
    },
  };
  await handler({ body, protocol: 'https', get: () => 'localhost' }, res, (err) => {
    result.error = err;
  });
  return result;
}

// Every one of these must be rejected as "not a single plain address".
const HOSTILE = [
  ['comma (two recipients)', 'a,b@evil.com'],
  ['comma list', 'victim@example.com,attacker@evil.com'],
  ['semicolon list', 'victim@example.com;attacker@evil.com'],
  ['angle brackets', '<victim@example.com>'],
  ['display name in angle brackets', 'Victim <victim@example.com>'],
  ['angle brackets after the address', 'attacker@evil.com<victim@example.com>'],
  ['inner space', 'vic tim@example.com'],
  ['space in the domain', 'victim@exa mple.com'],
  ['inner tab', 'victim@exam\tple.com'],
  ['CRLF header injection', 'victim@example.com\r\nBcc: attacker@evil.com'],
  ['bare LF injection', 'victim@example.com\nBcc: attacker@evil.com'],
  ['null byte', 'victim@exam\0ple.com'],
  ['non-ASCII local part', 'viktoré@example.com'],
  ['non-ASCII (IDN) domain', 'user@bücher.example'],
  ['Cyrillic lookalike domain', 'user@еxample.com'],
  ['Kelvin sign (lowercases to ASCII "k")', 'user@Kexample.com'],
  ['punycode domain', 'user@xn--bcher-kva.example'],
  ['quoted local part', '"a,b"@example.com'],
  ['two @', 'a@b@example.com'],
  ['no domain dot', 'user@localhost'],
];

const PLAIN_MALFORMED = 'notanemail';

test('signup rejects hostile addresses with the same error as any other bad address, and creates nothing', async () => {
  reset();
  const baseline = await run(signup, { email: PLAIN_MALFORMED, password: PASSWORD });
  assert.equal(baseline.error.status, 400);
  assert.equal(baseline.error.message, 'A valid email is required.');

  for (const [name, email] of HOSTILE) {
    reset();
    const result = await run(signup, { email, password: PASSWORD });
    assert.equal(result.error?.status, 400, `${name}: should be a 400`);
    assert.equal(result.error.message, baseline.error.message, `${name}: same message as any other bad address`);
    assert.equal(result.json, null, `${name}: no success response`);
    assert.equal(calls.findOne.length, 0, `${name}: not even looked up`);
    assert.equal(calls.create.length, 0, `${name}: no account created`);
    assert.equal(calls.mails.length, 0, `${name}: nothing mailed`);
  }
});

test('signup rejects non-string and missing emails before anything else', async () => {
  for (const email of [undefined, null, 5, ['a@example.com'], { $ne: null }]) {
    reset();
    const result = await run(signup, { email, password: PASSWORD });
    assert.equal(result.error?.status, 400);
    assert.equal(calls.create.length, 0);
    assert.equal(calls.mails.length, 0);
  }
});

test('signup still creates an account and mails exactly one clean address for a valid email', async () => {
  reset();
  const result = await run(signup, { email: '  Some.One+tag@Example.COM \r\n', password: PASSWORD });
  assert.equal(result.error, null);
  assert.equal(result.status, 200);
  assert.equal(typeof result.json.recoveryKey, 'string');
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].email, 'some.one+tag@example.com', 'trimmed and lowercased, trailing CRLF gone');
  assert.equal(calls.mails.length, 1);
  assert.equal(calls.mails[0].to, 'some.one+tag@example.com');
});

test('signup for an already-registered address keeps the same response shape and creates nothing', async () => {
  reset({ email: 'taken@example.com' });
  const result = await run(signup, { email: 'taken@example.com', password: PASSWORD });
  assert.equal(result.status, 200);
  assert.equal(typeof result.json.recoveryKey, 'string', 'decoy key keeps the shape identical');
  assert.equal(calls.create.length, 0);
});

for (const [label, handler, generic] of [
  ['resend-verification', resendVerification, 'If this account exists and is not yet verified, a new link has been sent.'],
]) {
  test(`${label}: hostile addresses get the generic response and trigger nothing`, async () => {
    reset();
    const unknownButValid = await run(handler, { email: 'nobody@example.com' });
    assert.equal(unknownButValid.status, 200);
    assert.equal(unknownButValid.json.message, generic);

    for (const [name, email] of HOSTILE) {
      reset({ emailVerified: false, email: 'would-match@example.com', save: async () => assert.fail('must not save') });
      const result = await run(handler, { email });
      assert.equal(result.error, null, `${name}: no error`);
      assert.equal(result.status, 200, `${name}: 200`);
      assert.deepEqual(result.json, unknownButValid.json, `${name}: byte-identical to any other outcome`);
      assert.equal(calls.findOne.length, 0, `${name}: not looked up`);
      assert.equal(calls.mails.length, 0, `${name}: nothing mailed`);
    }
  });

  test(`${label}: non-string emails are still a 400`, async () => {
    for (const email of [undefined, null, 5, ['a@example.com'], { $ne: null }]) {
      reset();
      const result = await run(handler, { email });
      assert.equal(result.error?.status, 400);
      assert.equal(calls.findOne.length, 0);
    }
  });
}

test('resend-verification still works for a valid address', async () => {
  const saves = [];
  reset({
    emailVerified: false,
    save: async () => saves.push('saved'),
  });
  const resent = await run(resendVerification, { email: ' Real.User@Example.com ' });
  assert.equal(resent.status, 200);
  assert.deepEqual(calls.findOne, [{ email: 'real.user@example.com' }]);
  assert.equal(calls.mails.length, 1);
  assert.equal(calls.mails[0].to, 'real.user@example.com');
  assert.equal(saves.length, 1);
});
