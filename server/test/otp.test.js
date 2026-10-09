// Run with: cd server && npm test   (Node's built-in test runner, no deps)
//
// Email one-time code on login. The models, mailer, session store and the
// per-account email budget are replaced with in-memory fakes BEFORE the
// controller loads, so every security property can be asserted directly.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');

for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']) delete process.env[name];
delete process.env.OTP_ENABLED;
delete process.env.OTP_TTL_MINUTES;
delete process.env.VERCEL;
process.env.NODE_ENV = 'test';

const cryptoUtils = require('../utils/crypto');

function stub(modulePath, exportsObject) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObject };
}

// ---------- fakes ----------
const world = { users: [], challenges: [], mails: [], sessions: [], budget: new Map() };
const oid = () => new mongoose.Types.ObjectId();

const matchValue = (actual, cond) => {
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !(cond instanceof mongoose.Types.ObjectId)) {
    if ('$lt' in cond && !(actual < cond.$lt)) return false;
    if ('$lte' in cond && !(actual <= cond.$lte)) return false;
    if ('$gt' in cond && !(actual > cond.$gt)) return false;
    if ('$gte' in cond && !(actual >= cond.$gte)) return false;
    return true;
  }
  if (actual instanceof Date && cond instanceof Date) return actual.getTime() === cond.getTime();
  return String(actual) === String(cond);
};
const matches = (doc, filter) =>
  Object.entries(filter).every(([key, cond]) =>
    key === '$or' ? cond.some((alternative) => matches(doc, alternative)) : matchValue(doc[key], cond)
  );

stub('../models/User', {
  findOne: async (query) => world.users.find((u) => u.email === query.email) || null,
  findById: async (id) => world.users.find((u) => String(u._id) === String(id)) || null,
});
stub('../models/OtpChallenge', {
  create: async (doc) => {
    const created = { _id: oid(), attempts: 0, resendCount: 0, ...doc };
    world.challenges.push(created);
    return created;
  },
  findOne: async (filter) => world.challenges.find((c) => matches(c, filter)) || null,
  findOneAndUpdate: async (filter, update, options) => {
    const doc = world.challenges.find((c) => matches(c, filter));
    if (!doc) return null;
    for (const [key, amount] of Object.entries(update.$inc || {})) doc[key] += amount;
    Object.assign(doc, update.$set || {});
    return options?.new ? doc : { ...doc };
  },
  findOneAndDelete: async (filter) => {
    const index = world.challenges.findIndex((c) => matches(c, filter));
    return index === -1 ? null : world.challenges.splice(index, 1)[0];
  },
  deleteOne: async (filter) => {
    const index = world.challenges.findIndex((c) => matches(c, filter));
    if (index !== -1) world.challenges.splice(index, 1);
    return { deletedCount: index === -1 ? 0 : 1 };
  },
});
stub('../middleware/rateLimit', {
  consumeBudget: async ({ name, key, max }) => {
    const id = `${name}:${key}`;
    const used = (world.budget.get(id) || 0) + 1;
    world.budget.set(id, used);
    return used <= max;
  },
});
const realEmail = require('../utils/email');
stub('../utils/email', {
  ...realEmail,
  sendEmail: async (message) => {
    world.mails.push(message);
    return true;
  },
});
stub('../utils/sessionStore', {
  createSession: async (userId, dek) => {
    const token = `session-${world.sessions.length + 1}`;
    world.sessions.push({ token, userId, dek });
    return token;
  },
  destroySession: async () => {},
  destroyAllSessionsForUser: async () => {},
});

// Devices and the activity log are covered in devices-audit.test.js; here a login just needs a device.
stub('../utils/deviceIdentity', {
  resolveDevice: async () => ({ device: { _id: oid() }, isNew: false, hadOtherDevices: false }),
  deviceFromCookie: async () => null,
  touchDevice: async () => {},
});
stub('../utils/audit', {
  recordEvent: async () => null,
  countryFrom: () => null,
  cityFrom: () => null,
});

const { unlock, verifyOtp, resendOtp } = require('../controllers/auth.controller');

// ---------- helpers ----------
const PASSWORD = 'Tk9$Lantern-Orbit%57';

function addUser(email, password = PASSWORD) {
  const salt = cryptoUtils.generateSalt();
  const dek = cryptoUtils.generateDEK();
  const wrapped = cryptoUtils.wrapKey(dek, cryptoUtils.deriveEncryptionKey(password, salt));
  const user = {
    _id: oid(),
    email,
    emailVerified: true,
    salt,
    passwordHash: cryptoUtils.hashPassword(password, salt),
    wrappedDEKPassword: wrapped.wrappedKey,
    wrappedDEKPasswordIv: wrapped.iv,
    wrappedDEKPasswordAuthTag: wrapped.authTag,
    failedAttempts: 0,
    save: async () => {},
    dek,
  };
  world.users.push(user);
  return user;
}

function reset() {
  world.users = [];
  world.challenges = [];
  world.mails = [];
  world.sessions = [];
  world.budget = new Map();
}

async function call(handler, body) {
  const out = { status: null, json: null, error: null };
  const res = {
    status(code) {
      out.status = code;
      return this;
    },
    json(payload) {
      out.json = payload;
      return this;
    },
  };
  const cookies = {};
  res.cookie = (name, value) => { cookies[name] = value; return res; };
  res.clearCookie = () => res;
  await handler({ body, headers: {}, secure: true }, res, (err) => {
    out.error = err;
  });
  return out;
}

const lastCode = () => /^(\d{6})$/m.exec(world.mails[world.mails.length - 1].text)[1];
const wrongCode = (real) => (real === '000000' ? '000001' : '000000');
const GENERIC = 'That code is incorrect or has expired.';

async function login(email = 'ana@example.com') {
  const result = await call(unlock, { email, password: PASSWORD });
  assert.equal(result.error, null);
  return result.json;
}

// ---------- tests ----------
test('password step: no session, a challenge is created and a code is emailed', async () => {
  reset();
  const user = addUser('ana@example.com');
  const challenge = await login();

  assert.equal(challenge.otpRequired, true);
  assert.equal(challenge.sessionToken, undefined, 'no session yet');
  assert.equal(world.sessions.length, 0);
  assert.match(challenge.challengeToken, /^[0-9a-f]{24}\.[0-9a-f]{64}$/);
  assert.equal(world.mails.length, 1);
  assert.equal(world.mails[0].to, 'ana@example.com');
  assert.match(world.mails[0].text, /expires in 5 minutes/);
  assert.match(world.mails[0].text, /If you didn't request this, ignore this email/i);
  assert.equal(world.challenges[0].userId, user._id);
  const ttl = new Date(challenge.expiresAt) - Date.now();
  assert.ok(ttl > 4.9 * 60 * 1000 && ttl <= 5 * 60 * 1000, 'default 5 minutes');
});

test('the stored challenge has no plaintext code, no challengeKey and no usable vault key', async () => {
  reset();
  const user = addUser('ana@example.com');
  const challenge = await login();
  const code = lastCode();
  const key = challenge.challengeToken.split('.')[1];
  const stored = JSON.stringify(world.challenges[0]);

  assert.ok(!stored.includes(code), 'no plaintext code');
  assert.ok(!stored.includes(key), 'no challengeKey');
  assert.ok(!stored.includes(user.dek.toString('hex')) && !stored.includes(user.dek.toString('base64')), 'no plaintext DEK');
  assert.deepEqual(
    Object.keys(world.challenges[0]).sort(),
    ['_id', 'attempts', 'codeHash', 'decoy', 'expiresAt', 'lastSentAt', 'purpose', 'resendCount', 'salt', 'userId', 'wrappedDek', 'wrappedDekAuthTag', 'wrappedDekIv'].sort()
  );
  // The wrapped key does not open with anything the database holds.
  const c = world.challenges[0];
  for (const guess of [Buffer.alloc(32), Buffer.from(c.salt, 'hex'), crypto.createHash('sha256').update(code).digest()]) {
    assert.throws(() => cryptoUtils.unwrapKey(c.wrappedDek, guess, c.wrappedDekIv, c.wrappedDekAuthTag));
  }
  assert.equal(c.codeHash, crypto.createHmac('sha256', Buffer.from(c.salt, 'hex')).update(code).digest('hex'), 'HMAC-SHA-256(salt, code)');
});

test('a correct code issues the session once; the same code cannot be used again', async () => {
  reset();
  const user = addUser('ana@example.com');
  const challenge = await login();
  const code = lastCode();

  const ok = await call(verifyOtp, { challengeToken: challenge.challengeToken, code });
  assert.equal(ok.error, null);
  assert.equal(ok.json.sessionToken, 'session-1');
  assert.equal(world.sessions.length, 1);
  assert.ok(world.sessions[0].dek.equals(user.dek), 'the session gets the real vault key');
  assert.equal(world.challenges.length, 0, 'challenge consumed');

  const again = await call(verifyOtp, { challengeToken: challenge.challengeToken, code });
  assert.equal(again.error.status, 401);
  assert.equal(again.error.message, GENERIC);
  assert.equal(world.sessions.length, 1, 'no second session');
});

test('two simultaneous correct submissions yield exactly one session', async () => {
  reset();
  addUser('ana@example.com');
  const challenge = await login();
  const code = lastCode();
  const results = await Promise.all([1, 2, 3].map(() => call(verifyOtp, { challengeToken: challenge.challengeToken, code })));
  assert.equal(results.filter((r) => r.json?.sessionToken).length, 1);
  assert.equal(world.sessions.length, 1);
});

test('five wrong codes kill the challenge, even for the correct code afterwards', async () => {
  reset();
  addUser('ana@example.com');
  const challenge = await login();
  const code = lastCode();
  for (let i = 0; i < 5; i += 1) {
    const bad = await call(verifyOtp, { challengeToken: challenge.challengeToken, code: wrongCode(code) });
    assert.equal(bad.error.message, GENERIC);
  }
  assert.equal(world.challenges.length, 0, 'deleted after the fifth');
  const late = await call(verifyOtp, { challengeToken: challenge.challengeToken, code });
  assert.equal(late.error.message, GENERIC);
  assert.equal(world.sessions.length, 0);
});

test('an expired code, a tampered challengeKey and malformed input all fail with the same error', async () => {
  reset();
  addUser('ana@example.com');

  let challenge = await login();
  let code = lastCode();
  world.challenges[0].expiresAt = new Date(Date.now() - 1000);
  const expired = await call(verifyOtp, { challengeToken: challenge.challengeToken, code });

  reset();
  addUser('ana@example.com');
  challenge = await login();
  code = lastCode();
  const [id, key] = challenge.challengeToken.split('.');
  const flipped = (key[0] === 'a' ? 'b' : 'a') + key.slice(1);
  const tampered = await call(verifyOtp, { challengeToken: `${id}.${flipped}`, code });
  assert.equal(world.challenges.length, 0, 'a mismatched key burns the challenge');

  const bad = [
    [undefined, code],
    [null, code],
    [12345, code],
    ['not-a-token', code],
    [`${id}.${key}`, undefined],
    [`${id}.${key}`, 123456],
    [`${id}.${key}`, '12345'],
    [`${id}.${key}`, '1234567'],
    [`${id}.${key}`, '12345a'],
    [`${id}.${key}`, { $ne: null }],
  ];
  const results = [expired, tampered];
  for (const [token, c] of bad) results.push(await call(verifyOtp, { challengeToken: token, code: c }));
  for (const result of results) {
    assert.equal(result.error.status, 401);
    assert.equal(result.error.message, GENERIC);
  }
  assert.equal(world.sessions.length, 0);
});

test("another account's challengeId with your own key fails", async () => {
  reset();
  addUser('ana@example.com');
  addUser('ben@example.com');
  const anas = await login('ana@example.com');
  const bens = await login('ben@example.com');
  const anasCode = lastCode().length && world.mails.find((m) => m.to === 'ana@example.com').text.match(/^(\d{6})$/m)[1];

  const mixed = `${anas.challengeToken.split('.')[0]}.${bens.challengeToken.split('.')[1]}`;
  const result = await call(verifyOtp, { challengeToken: mixed, code: anasCode });
  assert.equal(result.error.message, GENERIC, 'even with the right code, the key must match');
  assert.equal(world.sessions.length, 0);
  const resend = await call(resendOtp, { challengeToken: mixed });
  assert.equal(resend.error.message, GENERIC);
  assert.equal(world.mails.length, 2, 'and no email was sent for it');
});

test('resend: 60-second spacing, 3 per challenge, and the old code stops working', async () => {
  reset();
  addUser('ana@example.com');
  const challenge = await login();
  const first = lastCode();

  const tooSoon = await call(resendOtp, { challengeToken: challenge.challengeToken });
  assert.equal(tooSoon.error.status, 429);
  assert.ok(tooSoon.error.retryAfterSeconds > 0 && tooSoon.error.retryAfterSeconds <= 60);
  assert.equal(world.mails.length, 1, 'nothing sent inside the cooldown');

  const ageSend = () => {
    world.challenges[0].lastSentAt = new Date(Date.now() - 61 * 1000);
  };
  let previous = first;
  for (let i = 1; i <= 3; i += 1) {
    ageSend();
    const sent = await call(resendOtp, { challengeToken: challenge.challengeToken });
    assert.equal(sent.status, 200, `resend ${i}`);
    assert.equal(sent.json.resendsLeft, 3 - i);
    const next = lastCode();
    const old = await call(verifyOtp, { challengeToken: challenge.challengeToken, code: previous });
    if (previous !== next) assert.equal(old.error.message, GENERIC, 'the previous code no longer works');
    world.challenges[0].attempts = 0; // keep this assertion about resends, not attempts
    previous = next;
  }
  ageSend();
  const fourth = await call(resendOtp, { challengeToken: challenge.challengeToken });
  assert.equal(fourth.error.status, 429, 'a 4th resend is refused');
  assert.equal(world.mails.length, 4);

  const ok = await call(verifyOtp, { challengeToken: challenge.challengeToken, code: previous });
  assert.equal(ok.json.sessionToken, 'session-1', 'the newest code works');
});

test('at most 5 code emails per hour per account', async () => {
  reset();
  addUser('ana@example.com');
  for (let i = 0; i < 5; i += 1) await login();
  assert.equal(world.mails.length, 5);
  const sixth = await call(unlock, { email: 'ana@example.com', password: PASSWORD });
  assert.equal(sixth.error.status, 429);
  assert.equal(world.mails.length, 5, 'no 6th email');
  assert.equal(world.challenges.length, 5, 'and no 6th challenge');
});

test('the password step is unchanged: wrong password and unknown email are generic, no challenge, no email', async () => {
  reset();
  addUser('ana@example.com');
  const wrong = await call(unlock, { email: 'ana@example.com', password: 'Wrong-Password-1!' });
  const unknown = await call(unlock, { email: 'nobody@example.com', password: PASSWORD });
  assert.equal(wrong.error.status, 401);
  assert.equal(unknown.error.status, 401);
  assert.equal(wrong.error.message, unknown.error.message);
  assert.equal(world.challenges.length, 0);
  assert.equal(world.mails.length, 0);
});

test('OTP_ENABLED=false skips the code step outside production; production refuses to start', () => {
  const { assertOtpConfig, otpEnabled, otpTtlMinutes } = require('../utils/otpConfig');
  const saved = { ...process.env };
  const restore = () => {
    for (const name of ['OTP_ENABLED', 'OTP_TTL_MINUTES', 'NODE_ENV', 'VERCEL']) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  };
  try {
    assert.equal(otpEnabled(), true, 'on by default');
    assert.equal(otpTtlMinutes(), 5, 'default 5 minutes');

    process.env.OTP_ENABLED = 'false';
    process.env.NODE_ENV = 'development';
    assert.equal(otpEnabled(), false);
    assert.doesNotThrow(() => assertOtpConfig());

    process.env.NODE_ENV = 'production';
    assert.throws(() => assertOtpConfig(), /not allowed in production/);
    process.env.NODE_ENV = 'development';
    process.env.VERCEL = '1';
    assert.throws(() => assertOtpConfig(), /not allowed in production/, 'Vercel counts as production');
    process.env.OTP_ENABLED = '0';
    assert.throws(() => assertOtpConfig(), /not allowed in production/);
    delete process.env.OTP_ENABLED;
    assert.doesNotThrow(() => assertOtpConfig(), 'default (on) is fine in production');

    process.env.OTP_TTL_MINUTES = '10';
    assert.equal(otpTtlMinutes(), 10);
    for (const bad of ['0', '61', '2.5', 'abc', '-3']) {
      process.env.OTP_TTL_MINUTES = bad;
      assert.throws(() => assertOtpConfig(), /OTP_TTL_MINUTES/, bad);
    }
  } finally {
    restore();
  }
});

test('codes are uniform 6-digit strings and never logged in production', async () => {
  const { generateCode } = require('../utils/otp');
  const seen = new Set();
  for (let i = 0; i < 2000; i += 1) {
    const code = generateCode();
    assert.match(code, /^\d{6}$/);
    seen.add(code[0]);
  }
  assert.ok(seen.size >= 9, 'leading zeros and every leading digit occur');

  // The real mailer, in production with no SMTP: nothing is printed or sent.
  const { sendEmail } = realEmail;
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  const savedEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    const sent = await sendEmail({ to: 'ana@example.com', subject: 'Your Warden sign-in code', text: 'Your code:\n424242\n', html: '<p>424242</p>' });
    assert.equal(sent, false);
    process.env.NODE_ENV = 'development';
    const devSent = await sendEmail({ to: 'ana@example.com', subject: 'Your Warden sign-in code', text: 'Your code:\n424242\n', html: '<p>424242</p>' });
    assert.equal(devSent, true);
  } finally {
    console.log = original.log;
    console.error = original.error;
    process.env.NODE_ENV = savedEnv;
  }
  const productionLines = lines.slice(0, 1).join('\n');
  assert.ok(!productionLines.includes('424242'), 'production console has no code');
  assert.ok(lines.slice(1).join('\n').includes('424242'), 'development fallback may print it');
});
