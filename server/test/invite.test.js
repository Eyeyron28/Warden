// Run with: cd server && npm test
//
// The sign-up invite code, enforced on the server. The User model, the mailer and
// the rate-limit store are replaced with recording fakes BEFORE the controller is
// loaded, so each test can assert exactly what was looked up, created or mailed.
const test = require('node:test');
const assert = require('node:assert/strict');

for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']) delete process.env[name];
const CODE = 'Correct-Horse-Battery-Staple-42';
process.env.SIGNUP_MODE = 'invite';
process.env.INVITE_CODE = CODE;

const calls = { findOne: [], create: [], mails: [] };
let existingUser = null;

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

// In-memory stand-in for the Mongo-backed budgets (same semantics, no windows).
const counts = new Map();
stub('../middleware/rateLimit', {
  consumeBudget: async ({ name, key, max }) => {
    const id = `${name}:${key}`;
    counts.set(id, (counts.get(id) || 0) + 1);
    return counts.get(id) <= max;
  },
  budgetRetryAfterSeconds: async ({ name, key, max }) => ((counts.get(`${name}:${key}`) || 0) >= max ? 600 : 0),
  isBudgetExhausted: async () => false,
});

const { signup, getPublicConfig } = require('../controllers/auth.controller');

const PASSWORD = 'Tk9$Lantern-Orbit%57';
let ipCounter = 0;
const freshIp = () => `198.51.100.${++ipCounter}`;

function reset(user = null) {
  calls.findOne.length = 0;
  calls.create.length = 0;
  calls.mails.length = 0;
  existingUser = user;
}

async function run(handler, body, ip = freshIp()) {
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
  await handler({ body, ip, protocol: 'https', get: () => 'localhost' }, res, (err) => {
    result.error = err;
  });
  return result;
}

const nothingHappened = () => {
  assert.deepEqual(calls.findOne, [], 'no email lookup');
  assert.deepEqual(calls.create, [], 'no account');
  assert.deepEqual(calls.mails, [], 'no email sent');
};

const signupBody = (inviteCode, extra = {}) => ({ email: 'new@example.com', password: PASSWORD, ...(inviteCode === undefined ? {} : { inviteCode }), ...extra });

test('a missing, empty, whitespace, wrong, oversized or wrong-typed code is refused the same way, doing no work', async () => {
  const bad = [
    ['absent', undefined],
    ['empty', ''],
    ['spaces only', '   \t '],
    ['wrong', 'not-the-code'],
    ['almost right', `${CODE}x`],
    ['very long', 'A'.repeat(100000)],
    ['number', 12345],
    ['boolean', true],
    ['null', null],
    ['array', [CODE]],
    ['object', { $ne: null }],
    ['object with the code inside', { code: CODE }],
  ];
  const seen = new Set();
  for (const [label, value] of bad) {
    reset();
    const out = await run(signup, signupBody(value));
    assert.equal(out.error?.status, 403, label);
    assert.equal(out.error.code, 'INVITE_CODE_INVALID', label);
    assert.equal(out.error.message, 'The invite code is missing or incorrect.', label);
    assert.equal(out.json, null, label);
    nothingHappened();
    seen.add(JSON.stringify([out.error.status, out.error.code, out.error.message]));
  }
  assert.equal(seen.size, 1, 'one single answer for every kind of bad code');
});

test('the check comes before the email is even validated: a bad code and a bad email give the code error', async () => {
  reset();
  const out = await run(signup, { email: 'a,b@evil.com', password: 'x', inviteCode: 'wrong' });
  assert.equal(out.error.code, 'INVITE_CODE_INVALID');
  nothingHappened();
});

test('the right code creates the account and sends the verification email; surrounding spaces are fine', async () => {
  for (const code of [CODE, `  ${CODE}  `, `\t${CODE}\n`]) {
    reset();
    const out = await run(signup, signupBody(code));
    assert.equal(out.error, null);
    assert.equal(out.status, 200);
    assert.equal(calls.create.length, 1);
    assert.equal(calls.mails.length, 1);
    assert.match(calls.mails[0].subject, /Verify your Warden account/);
  }
});

test('wrong code + an existing email: nobody is emailed (the owner is not contacted)', async () => {
  reset({ email: 'owner@example.com' });
  const out = await run(signup, { email: 'owner@example.com', password: PASSWORD, inviteCode: 'wrong' });
  assert.equal(out.error.code, 'INVITE_CODE_INVALID');
  nothingHappened();
});

test('right code + existing email keeps the anti-enumeration behaviour (same shape, decoy key, heads-up email)', async () => {
  reset({ email: 'owner@example.com' });
  const out = await run(signup, { email: 'owner@example.com', password: PASSWORD, inviteCode: CODE });
  assert.equal(out.status, 200);
  assert.ok(out.json.recoveryKey);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.mails.length, 1);
});

test('failures are limited per IP: the 6th attempt is refused even with the right code; other IPs are unaffected', async () => {
  reset();
  const ip = freshIp();
  for (let i = 0; i < 5; i += 1) {
    const out = await run(signup, signupBody(`wrong-${i}`), ip);
    assert.equal(out.error.status, 403, `attempt ${i + 1}`);
  }
  const blocked = await run(signup, signupBody(CODE), ip);
  assert.equal(blocked.error.status, 429);
  assert.equal(blocked.error.message, 'Too many requests. Please try again shortly.');
  assert.ok(blocked.error.retryAfterSeconds > 0);
  nothingHappened();

  const other = await run(signup, signupBody(CODE), freshIp());
  assert.equal(other.error, null, 'a different IP is not affected');
  assert.equal(other.status, 200);
});

test('a successful signup does not spend the failure budget', async () => {
  reset();
  const ip = freshIp();
  for (let i = 0; i < 12; i += 1) {
    const out = await run(signup, signupBody(CODE, { email: `ok${i}@example.com` }), ip);
    assert.equal(out.error, null);
  }
});

test('open mode: no code is needed and any submitted code is ignored; only "open" opens it', async () => {
  process.env.SIGNUP_MODE = 'open';
  try {
    for (const value of [undefined, 'whatever', [1], { a: 1 }]) {
      reset();
      const out = await run(signup, signupBody(value));
      assert.equal(out.error, null);
      assert.equal(calls.create.length, 1);
    }
  } finally {
    process.env.SIGNUP_MODE = 'invite';
  }
  // A misspelt mode must not leave sign-up open.
  for (const mode of ['closed', 'invited', 'OPEN-ish', '', undefined]) {
    if (mode === undefined) delete process.env.SIGNUP_MODE;
    else process.env.SIGNUP_MODE = mode;
    reset();
    const out = await run(signup, signupBody(undefined));
    assert.equal(out.error?.code, 'INVITE_CODE_INVALID', String(mode));
  }
  process.env.SIGNUP_MODE = ' Open ';
  reset();
  assert.equal((await run(signup, signupBody(undefined))).error, null, 'case and spaces around "open" are tolerated');
  process.env.SIGNUP_MODE = 'invite';
});

test('invite mode with no INVITE_CODE configured refuses everyone (including an empty code)', async () => {
  delete process.env.INVITE_CODE;
  try {
    for (const value of ['', undefined, 'anything']) {
      reset();
      const out = await run(signup, signupBody(value));
      assert.equal(out.error.code, 'INVITE_CODE_INVALID');
      nothingHappened();
    }
  } finally {
    process.env.INVITE_CODE = CODE;
  }
});

test('the code never appears in an error, a response or the log', async () => {
  const logged = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => logged.push(a.join(' '));
  console.warn = console.log;
  console.error = console.log;
  let out;
  try {
    reset();
    out = await run(signup, signupBody(`${CODE}-nope`));
    reset();
    await run(signup, signupBody(CODE));
  } finally {
    Object.assign(console, originals);
  }
  const everything = JSON.stringify([out.error?.message, out.error?.code, out.json, logged, calls.mails]);
  assert.ok(!everything.includes(CODE), 'the real code is nowhere in the output');
  assert.ok(!everything.includes(`${CODE}-nope`), 'nor is the submitted one');
});

test('config: signupMode, plus REQUEST_ACCESS_TEXT as sanitised plain text in invite mode only', () => {
  const get = () => {
    let body;
    getPublicConfig({}, { status: () => ({ json: (b) => { body = b; } }) });
    return body;
  };
  delete process.env.REQUEST_ACCESS_TEXT;
  assert.deepEqual(get(), { signupMode: 'invite' });

  process.env.REQUEST_ACCESS_TEXT = '  Ask  Sam\u0007 at\r\nsam@example.com‮  ';
  assert.deepEqual(get(), { signupMode: 'invite', requestAccessText: 'Ask Sam at sam@example.com' });

  process.env.REQUEST_ACCESS_TEXT = '<img src=x onerror=alert(1)>'.padEnd(500, 'a');
  const text = get().requestAccessText;
  assert.equal([...text].length, 200);
  assert.ok(text.startsWith('<img'), 'markup is kept as characters, never interpreted (the page renders text)');

  process.env.SIGNUP_MODE = 'open';
  assert.deepEqual(get(), { signupMode: 'open' }, 'nothing about access requests in open mode');
  process.env.SIGNUP_MODE = 'invite';
  assert.ok(!JSON.stringify(get()).includes(CODE));
  delete process.env.REQUEST_ACCESS_TEXT;
});
