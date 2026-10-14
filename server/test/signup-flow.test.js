// Run with: cd server && npm test
//
// Sign-up proves the email BEFORE an account exists (controllers/signup.controller.js), against a REAL local MongoDB
// (test/helpers/realMongo.js; skipped, with the reason, when none answers). Mail is captured, DNS is stood in for, and
// nothing reads an .env file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']) delete process.env[name];
delete process.env.VERCEL;
delete process.env.OTP_TTL_MINUTES;
process.env.NODE_ENV = 'test';
process.env.SIGNUP_MODE = 'open';
process.env.PUBLIC_APP_URL = 'https://warden.test';

const mails = [];
const emailPath = require.resolve('../utils/email');
const realEmail = require('../utils/email');
require.cache[emailPath].exports = { ...realEmail, sendEmail: async (message) => { mails.push(message); return true; } };

const { connectThrowaway, disconnectThrowaway, mongoose } = require('./helpers/realMongo');
const { call } = require('./helpers/fakeDb');
const { makeUser } = require('./helpers/makeUser');

const dns = require('node:dns').promises;
const realDns = { resolveMx: dns.resolveMx, resolve4: dns.resolve4, resolve6: dns.resolve6 };
const dnsError = (code) => Object.assign(new Error(code), { code });
function dnsSays({ mx, a, aaaa } = {}) {
  const answer = (value) => async () => {
    if (value instanceof Error) throw value;
    return value;
  };
  dns.resolveMx = answer(mx ?? [{ exchange: 'mx.example.com', priority: 10 }]);
  dns.resolve4 = answer(a ?? dnsError('ENODATA'));
  dns.resolve6 = answer(aaaa ?? dnsError('ENODATA'));
}

const { signupStart, signupVerify, signupResend, VERIFY_FAILED, NO_MAIL_DOMAIN } = require('../controllers/signup.controller');
const { verifyOtp } = require('../controllers/auth.controller');
const { forgetDomains } = require('../utils/emailDomain');
const { getSession } = require('../utils/sessionStore');
const { purgeLegacyUnverified } = require('../utils/legacyCleanup');
const User = require('../models/User');
const OtpChallenge = require('../models/OtpChallenge');
const Document = require('../models/Document');
const Session = require('../models/Session');
const Device = require('../models/Device');
const TrustedDevice = require('../models/TrustedDevice');
const RateLimit = require('../models/RateLimit');

const PASSWORD = 'Qx7!vTr29#mLpw';
let connected = { ok: false, reason: '' };
test.before(async () => {
  connected = await connectThrowaway('signup_flow');
  if (connected.ok) await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
});
test.after(async () => {
  Object.assign(dns, realDns);
  await disconnectThrowaway();
});
const it = (name, fn) =>
  test(name, async (context) => {
    if (!connected.ok) return context.skip(connected.reason);
    await mongoose.connection.dropDatabase();
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
    mails.length = 0;
    forgetDomains();
    dnsSays();
    return fn(context);
  });

const start = (email, extra = {}, ip = '203.0.113.5') => call(signupStart, { body: { email, password: PASSWORD, termsAccepted: true, ...extra }, ip });
const verify = (email, code, extra = {}, ip = '203.0.113.5') => call(signupVerify, { body: { email, password: PASSWORD, code, ...extra }, ip, headers: { 'user-agent': 'Mozilla/5.0 Chrome/126.0' } });
const resend = (email, ip = '203.0.113.5') => call(signupResend, { body: { email }, ip });
const codeIn = (mail) => /(?<![\d-])(\d{6})(?![\d-])/.exec(mail.text)[1];
const lastCodeTo = (address) => codeIn(mails.filter((m) => m.to === address).at(-1));
const counts = async () => ({
  users: await User.countDocuments({}), sessions: await Session.countDocuments({}), devices: await Device.countDocuments({}),
  documents: await Document.countDocuments({}), trusted: await TrustedDevice.countDocuments({}), challenges: await OtpChallenge.countDocuments({}),
});

it('start creates NO user, vault, key or session - only a pending code - and the response carries no key material', async () => {
  const out = await start('new.person@example.com');
  assert.equal(out.error, null);
  assert.equal(out.status, 200);
  assert.deepEqual(await counts(), { users: 0, sessions: 0, devices: 0, documents: 0, trusted: 0, challenges: 1 });
  const text = JSON.stringify(out.json);
  assert.ok(!/recoveryKey|sessionToken|wrappedDEK|dek/i.test(text), text);
  assert.equal(out.json.otpRequired, true);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /sign-up code/i);

  // the pending record: the code only as a salted hash, the address only as an HMAC, and no password anywhere
  const pending = await OtpChallenge.findOne({}).lean();
  const stored = JSON.stringify(pending);
  assert.equal(pending.purpose, 'signup');
  assert.ok(!stored.includes(PASSWORD) && !stored.includes('new.person') && !stored.includes(codeIn(mails[0])), 'no password, no address, no code in the clear');
  assert.match(pending.subjectKey, /^[0-9a-f]{64}$/);
  assert.equal(pending.userId, undefined);
});

it('a mailbox nobody owns leaves no account: the code is never entered, and once it expires it cannot be used', async () => {
  await start('nobody.owns.this@example.com');
  assert.equal(await User.countDocuments({}), 0);
  const code = lastCodeTo('nobody.owns.this@example.com');
  await OtpChallenge.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } }); // the time has passed
  const late = await verify('nobody.owns.this@example.com', code);
  assert.equal(late.error?.status, 401);
  assert.equal(late.error.message, VERIFY_FAILED);
  assert.equal(await User.countDocuments({}), 0);
  assert.equal(await OtpChallenge.countDocuments({ expiresAt: { $gt: new Date() } }), 0);
});

it('the pending code is removed by Mongo after its expiry (a TTL index)', async () => {
  const indexes = await OtpChallenge.collection.indexes();
  const ttl = indexes.find((index) => index.key.expiresAt === 1);
  assert.equal(ttl.expireAfterSeconds, 0);
});

it('the right code creates the account, returns the recovery key ONCE and signs in without a second code or a trusted browser', async () => {
  await start('new.person@example.com');
  const code = lastCodeTo('new.person@example.com');
  const out = await verify('new.person@example.com', code);
  assert.equal(out.error, null);
  assert.equal(out.status, 200);
  assert.match(out.json.recoveryKey, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/, 'the same recovery key format as ever');
  assert.match(out.json.sessionToken, /^[0-9a-f]{64}\.[0-9a-f]{64}$/);
  assert.equal(out.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(out.json).sort(), ['recoveryKey', 'sessionToken']);

  const user = await User.findOne({ email: 'new.person@example.com' }).lean();
  assert.equal(user.emailVerified, true);
  assert.ok(!JSON.stringify(user).includes(out.json.recoveryKey), 'the key is not stored in the clear');
  assert.equal(await TrustedDevice.countDocuments({}), 0, 'the browser is not trusted by default');
  assert.deepEqual(out.cookies && Object.keys(out.cookies).filter((name) => /trust/i.test(name)), []);
  assert.equal(await Session.countDocuments({ userId: user._id }), 1);
  const session = await getSession(out.json.sessionToken);
  assert.equal(String(session.userId), String(user._id));
  assert.equal(session.dek.length, 32, 'the vault key was unwrapped from the token: the account really opens');

  // the key never comes back: not from a second verify, not from the pending record, not from any later response
  const again = await verify('new.person@example.com', code);
  assert.equal(again.error?.status, 401);
  assert.ok(!JSON.stringify(again).includes(out.json.recoveryKey));
});

it('login with the new password still goes through the emailed code (sign-up changed nothing about login)', async () => {
  await start('new.person@example.com');
  await verify('new.person@example.com', lastCodeTo('new.person@example.com'));
  const unlock = await call(require('../controllers/auth.controller').unlock, { body: { email: 'new.person@example.com', password: PASSWORD }, headers: {} });
  assert.equal(unlock.error, null);
  assert.equal(unlock.json.otpRequired, true, 'a normal login still asks for its code');
});

it('wrong, reused and cross-purpose codes are refused with one generic message; five wrong guesses kill the code', async () => {
  await start('a@example.com');
  const code = lastCodeTo('a@example.com');
  const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');
  for (let i = 0; i < 4; i += 1) {
    const out = await verify('a@example.com', wrong);
    assert.equal(out.error?.status, 401);
    assert.equal(out.error.message, VERIFY_FAILED);
  }
  // the 5th guess is the last: even the right code afterwards is useless
  assert.equal((await verify('a@example.com', wrong)).error.status, 401);
  assert.equal((await verify('a@example.com', code)).error.message, VERIFY_FAILED);
  assert.equal(await User.countDocuments({}), 0);
  assert.equal(await OtpChallenge.countDocuments({ purpose: 'signup' }), 0, 'the dead challenge is gone');

  // the same message for an address that never asked, a malformed code and a malformed address
  for (const attempt of [verify('never.asked@example.com', '123456'), verify('a@example.com', 'abc'), verify('not-an-email', '123456')]) {
    const out = await attempt;
    assert.equal(out.error.status, 401);
    assert.equal(out.error.message, VERIFY_FAILED);
  }
});

it('the guess is counted before it is checked: 12 parallel wrong guesses use at most 5 attempts', async () => {
  await start('race@example.com');
  const wrong = String((Number(lastCodeTo('race@example.com')) + 1) % 1000000).padStart(6, '0');
  await Promise.all(Array.from({ length: 12 }, () => verify('race@example.com', wrong)));
  const left = await OtpChallenge.findOne({ purpose: 'signup' }).lean();
  assert.ok(!left || left.attempts <= 5, `attempts ${left?.attempts}`);
});

it('a login code cannot complete sign-up, and a sign-up code cannot complete a login', async () => {
  const owner = await makeUser(User, 'owner@example.com', PASSWORD);
  // a login code for an existing account
  const { startChallenge, PURPOSES } = require('../utils/otpChallenge');
  await startChallenge({ user: owner, secret: Buffer.alloc(32, 1), purpose: PURPOSES.login });
  const loginCode = codeIn(mails.at(-1));
  await start('someone.new@example.com');
  assert.equal((await verify('someone.new@example.com', loginCode)).error?.status, 401, 'a login code does not open a sign-up');
  assert.equal((await verify('owner@example.com', loginCode)).error?.status, 401, 'nor for the owner’s own address');
  assert.equal(await User.countDocuments({}), 1);

  // a sign-up code in the login step: there is no challenge token for it, and a forged one finds nothing
  const forged = `${(await OtpChallenge.findOne({ purpose: 'signup' }))._id}.${'ab'.repeat(32)}`;
  const out = await call(verifyOtp, { body: { challengeToken: forged, code: lastCodeTo('someone.new@example.com') }, headers: {} });
  assert.equal(out.error?.status, 401);
  assert.equal(await Session.countDocuments({}), 0);
});

it('resend: neutral answer, 60-second gap, three resends, five code emails an hour; only for a pending address with no account', async () => {
  await start('r@example.com');
  assert.equal(mails.length, 1);
  const first = lastCodeTo('r@example.com');

  // too soon: the same answer, nothing sent
  const tooSoon = await resend('r@example.com');
  assert.equal(tooSoon.status, 200);
  assert.equal(mails.length, 1, 'inside the gap nothing is sent');

  for (let i = 1; i <= 3; i += 1) {
    await OtpChallenge.updateMany({ purpose: 'signup' }, { $set: { lastSentAt: new Date(Date.now() - 61 * 1000) } });
    const out = await resend('r@example.com');
    assert.equal(out.status, 200);
    assert.equal(mails.length, 1 + i, `resend ${i} sent a code`);
  }
  await OtpChallenge.updateMany({ purpose: 'signup' }, { $set: { lastSentAt: new Date(Date.now() - 61 * 1000) } });
  await resend('r@example.com');
  assert.equal(mails.length, 4, 'a fourth resend is not sent');

  // the newest code works; the first one no longer does
  const newest = lastCodeTo('r@example.com');
  assert.notEqual(newest, first);
  assert.equal((await verify('r@example.com', first)).error?.status, 401);

  // no pending code, and an existing account: the same answer, nothing sent
  const before = mails.length;
  const noPending = await resend('stranger@example.com');
  await makeUser(User, 'has.account@example.com', PASSWORD);
  const hasAccount = await resend('has.account@example.com');
  assert.deepEqual(Object.keys(noPending.json).sort(), Object.keys(tooSoon.json).sort());
  assert.deepEqual(Object.keys(hasAccount.json).sort(), Object.keys(tooSoon.json).sort());
  assert.equal(noPending.json.message, hasAccount.json.message);
  assert.equal(mails.length, before);
});

it('at most five code emails an hour per address, however they are asked for', async () => {
  const seen = [];
  for (let i = 0; i < 7; i += 1) seen.push((await start('busy@example.com')).error?.status ?? 200);
  assert.deepEqual(seen, [200, 200, 200, 200, 200, 429, 429]);
  assert.equal(mails.length, 5);
});

it('an existing address gets the heads-up and NO code, and the answer has the same shape as for a new address', async () => {
  await makeUser(User, 'taken@example.com', PASSWORD);
  const taken = await start('taken@example.com');
  const fresh = await start('brand.new@example.com');
  assert.equal(taken.status, 200);
  assert.deepEqual(Object.keys(taken.json).sort(), Object.keys(fresh.json).sort());
  assert.equal(taken.json.message, fresh.json.message);
  assert.equal(taken.json.otpRequired, fresh.json.otpRequired);
  const toTaken = mails.filter((m) => m.to === 'taken@example.com');
  assert.equal(toTaken.length, 1);
  assert.match(toTaken[0].subject, /Someone tried to sign up/);
  assert.ok(!/\b\d{6}\b/.test(toTaken[0].text.replace(/\d{1,2}:\d{2}/g, '')), 'no code in the owner notice');
  assert.equal(await OtpChallenge.countDocuments({}), 1, 'only the new address has a pending code');
  // and the unused code of the new address cannot be used against the existing one
  const code = lastCodeTo('brand.new@example.com');
  assert.equal((await verify('taken@example.com', code)).error?.status, 401);
});

it('parallel verifies for one address create exactly one account; every other caller gets the generic failure', async () => {
  await start('parallel@example.com');
  const code = lastCodeTo('parallel@example.com');
  const results = await Promise.all(Array.from({ length: 8 }, () => verify('parallel@example.com', code)));
  const winners = results.filter((out) => !out.error);
  assert.equal(winners.length, 1);
  assert.equal(await User.countDocuments({ email: 'parallel@example.com' }), 1);
  for (const out of results.filter((r) => r.error)) {
    assert.equal(out.error.status, 401);
    assert.equal(out.error.message, VERIFY_FAILED);
    assert.ok(!/E11000|duplicate/i.test(out.error.message));
  }
  assert.equal(results.filter((out) => out.json?.recoveryKey).length, 1, 'the recovery key is in exactly one response');
});

it('a duplicate-key race at create time is the same generic failure', async (context) => {
  await start('dup@example.com');
  const code = lastCodeTo('dup@example.com');
  context.mock.method(User, 'create', async () => {
    throw Object.assign(new Error('E11000 duplicate key error collection: x index: email_1'), { code: 11000 });
  });
  const out = await verify('dup@example.com', code);
  assert.equal(out.error?.status, 401);
  assert.equal(out.error.message, VERIFY_FAILED);
});

it('the password is re-checked at verify and is never stored with the pending code', async () => {
  await start('weak@example.com');
  const code = lastCodeTo('weak@example.com');
  const weak = await verify('weak@example.com', code, { password: 'short' });
  assert.equal(weak.error?.status, 400, 'a weak password is refused...');
  assert.equal((await OtpChallenge.findOne({ purpose: 'signup' }).lean()).attempts, 0, '...without using a guess');
  assert.equal((await verify('weak@example.com', code)).error, null, 'and the same code still works with a good one');
});

it('start refuses a weak password, a missing terms box and a malformed address before doing anything', async () => {
  const weak = await call(signupStart, { body: { email: 'x@example.com', password: 'weak', termsAccepted: true }, ip: '203.0.113.9' });
  assert.equal(weak.error.status, 400);
  const noTerms = await call(signupStart, { body: { email: 'x@example.com', password: PASSWORD }, ip: '203.0.113.9' });
  assert.equal(noTerms.error.status, 400);
  assert.match(noTerms.error.message, /Terms of use/);
  const bad = await call(signupStart, { body: { email: 'a,b@evil.com', password: PASSWORD, termsAccepted: true }, ip: '203.0.113.9' });
  assert.equal(bad.error.status, 400);
  assert.deepEqual(await counts(), { users: 0, sessions: 0, devices: 0, documents: 0, trusted: 0, challenges: 0 });
  assert.equal(mails.length, 0);
});

it('a domain that cannot receive mail is refused with a clear message; a DNS timeout never blocks sign-up', async () => {
  dnsSays({ mx: dnsError('ENOTFOUND'), a: dnsError('ENOTFOUND'), aaaa: dnsError('ENOTFOUND') });
  const gone = await start('x@no-such-domain.example');
  assert.equal(gone.error?.status, 400);
  assert.equal(gone.error.message, NO_MAIL_DOMAIN);
  assert.equal(gone.error.message, 'That email domain can’t receive mail. Check for a typo.');
  assert.equal(mails.length, 0);
  assert.equal(await OtpChallenge.countDocuments({}), 0);

  forgetDomains();
  dnsSays({ mx: [{ exchange: '.', priority: 0 }] }); // a "null MX": the domain says it takes no mail
  assert.equal((await start('x@nullmx.example')).error?.message, NO_MAIL_DOMAIN);

  forgetDomains();
  dnsSays({ mx: dnsError('ENODATA'), a: ['203.0.113.7'] }); // no MX, but an address: the mail standard falls back to it
  assert.equal((await start('x@fallback.example')).error, null);

  forgetDomains();
  dnsSays({ mx: dnsError('ENODATA'), a: dnsError('ENODATA'), aaaa: ['2001:db8::1'] });
  assert.equal((await start('x@v6only.example')).error, null);

  forgetDomains();
  dnsSays({ mx: dnsError('ETIMEOUT'), a: dnsError('ETIMEOUT'), aaaa: dnsError('ETIMEOUT') });
  assert.equal((await start('x@slow.example')).error, null, 'a timeout lets sign-up continue');
  forgetDomains();
  dnsSays({ mx: dnsError('ESERVFAIL') });
  assert.equal((await start('y@broken-resolver.example')).error, null, 'so does a server failure');

  // a lookup that simply never answers is cut off by the short timeout
  forgetDomains();
  dns.resolveMx = () => new Promise(() => {});
  const { domainCanReceiveMail } = require('../utils/emailDomain');
  const started = Date.now();
  assert.equal(await domainCanReceiveMail('x@hangs.example', { timeoutMs: 100 }), true);
  assert.ok(Date.now() - started < 2000);
});

it('the single place that makes a login session is issueLoginSession: no other path calls createSession', async () => {
  const root = path.join(__dirname, '..');
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'test', 'scripts'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const code = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        if (/\bcreateSession\s*\(/.test(code)) hits.push(path.relative(root, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(root);
  // the definition, the one login/sign-up issuer, and Emergency Access's own read-only session
  assert.deepEqual(hits.sort(), ['controllers/auth.controller.js', 'utils/emergency/service.js', 'utils/sessionStore.js']);
  const signupSource = fs.readFileSync(path.join(root, 'controllers', 'signup.controller.js'), 'utf8');
  assert.match(signupSource, /issueLoginSession\(req, res, user, dek, \{ trust: false \}\)/);
  assert.doesNotMatch(signupSource, /createSession/);
});

it('the old one-step sign-up route is gone: it creates nothing', async () => {
  const { goneSignup } = require('../controllers/signup.controller');
  const out = await call(goneSignup, { body: { email: 'old@example.com', password: PASSWORD } });
  assert.equal(out.status, 410);
  assert.equal(await User.countDocuments({}), 0);
  const routes = require('../routes/auth.routes');
  const layer = (path) => routes.stack.find((l) => l.route?.path === path);
  assert.ok(layer('/signup/start') && layer('/signup/verify') && layer('/signup/resend'));
  assert.equal(layer('/signup').route.stack.at(-1).handle, goneSignup);
});

it('the route runs the invite gate before anything else about the request', async () => {
  const routes = require('../routes/auth.routes');
  const { inviteGate } = require('../utils/inviteGate');
  const chain = routes.stack.find((l) => l.route?.path === '/signup/start').route.stack.map((s) => s.handle);
  const gate = chain.indexOf(inviteGate);
  assert.ok(gate >= 0, 'the invite gate is on the route');
  assert.equal(chain.at(-1), signupStart);
  assert.ok(gate < chain.indexOf(signupStart));
  // only the per-connection limiter may come before it
  assert.ok(gate <= 1);
});

it('per-connection limits: the 11th start from one address in an hour is refused (the route limiter)', async () => {
  const createRateLimiter = require('../middleware/rateLimit');
  const limiter = createRateLimiter({ name: 'signup-ip-test', max: 10, windowMs: 60 * 60 * 1000 });
  await RateLimit.deleteMany({});
  const seen = [];
  for (let i = 0; i < 12; i += 1) {
    let error = null;
    await limiter({ ip: '203.0.113.77', body: {} }, {}, (err) => { error = err || null; });
    seen.push(error?.status ?? 200);
  }
  assert.deepEqual(seen.slice(9), [200, 429, 429]);
  const routes = require('../routes/auth.routes');
  const names = ['/signup/start', '/signup/verify', '/signup/resend'].map((p) => routes.stack.find((l) => l.route?.path === p).route.stack.length);
  assert.deepEqual(names, [4, 2, 3], 'start: ip limit, invite gate, address limit, handler; verify: limit, handler; resend: two limits, handler');
});

it('legacy clean-up removes only unverified accounts older than 24 hours that hold no documents', async () => {
  const day = 24 * 60 * 60 * 1000;
  const make = async (email, { verified, ageMs, withDocument = false }) => {
    const user = await makeUser(User, email, PASSWORD, { emailVerified: verified });
    await User.collection.updateOne({ _id: user._id }, { $set: { createdAt: new Date(Date.now() - ageMs) } }); // createdAt is immutable through the model
    if (withDocument) {
      await Document.create({ userId: user._id, filename: 'x.pdf', mimeType: 'application/pdf', encryptedBlob: Buffer.from('x'), iv: 'a', authTag: 'b', checksum: 'c', folder: 'root', originDevice: 'pc' });
    }
    return user;
  };
  await make('old-junk@example.com', { verified: false, ageMs: 3 * day });
  await make('old-junk-2@example.com', { verified: false, ageMs: 25 * 60 * 60 * 1000 });
  await make('old-with-file@example.com', { verified: false, ageMs: 3 * day, withDocument: true });
  await make('young-unverified@example.com', { verified: false, ageMs: 2 * 60 * 60 * 1000 });
  await make('old-verified@example.com', { verified: true, ageMs: 30 * day });
  await make('old-verified-empty@example.com', { verified: true, ageMs: 30 * day });

  const result = await purgeLegacyUnverified();
  assert.equal(result.removed, 2);
  const left = (await User.find({}).lean()).map((u) => u.email).sort();
  assert.deepEqual(left, ['old-verified-empty@example.com', 'old-verified@example.com', 'old-with-file@example.com', 'young-unverified@example.com']);
  assert.equal((await purgeLegacyUnverified()).removed, 0, 'idempotent');
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'routes', 'cron.routes.js'), 'utf8').includes('purgeLegacyUnverified'), 'it rides on the existing daily job');
});

it('the lifetime shown in the code email is the lifetime the code really has (OTP_TTL_MINUTES)', async () => {
  const saved = process.env.OTP_TTL_MINUTES;
  process.env.OTP_TTL_MINUTES = '7';
  try {
    const out = await start('ttl@example.com');
    assert.match(mails.at(-1).text, /expires in 7 minutes/);
    const pending = await OtpChallenge.findOne({ purpose: 'signup' }).lean();
    assert.equal(pending.expiresAt.getTime() - pending.lastSentAt.getTime(), 7 * 60 * 1000);
    assert.ok(Math.abs(new Date(out.json.expiresAt).getTime() - Date.now() - 7 * 60 * 1000) < 5000, 'and so does the answer');
  } finally {
    if (saved === undefined) delete process.env.OTP_TTL_MINUTES;
    else process.env.OTP_TTL_MINUTES = saved;
  }
});

it('the legacy link flow still works for an account that was made the old way and is still unverified', async () => {
  const crypto = require('node:crypto');
  const { verifyEmail } = require('../controllers/auth.controller');
  const user = await makeUser(User, 'legacy@example.com', PASSWORD, { emailVerified: false });
  const token = 'legacy-token-value';
  await User.updateOne({ _id: user._id }, { $set: { verificationTokenHash: crypto.createHash('sha256').update(token).digest('hex'), verificationTokenExpiresAt: new Date(Date.now() + 3600e3) } });
  const out = await call(verifyEmail, { body: { token } });
  assert.equal(out.error, null);
  assert.equal((await User.findOne({ email: 'legacy@example.com' }).lean()).emailVerified, true);
});
