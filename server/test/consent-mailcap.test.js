// Run with: cd server && npm test
//
// Part A: consent is recorded at sign-up (server side) and written to the account with the policy version.
// Part B: a daily mail budget keeps bulk mail (sign-up codes, notices, reminders) from using up the provider's daily limit
//         and leaving real login codes with nothing to send them; one shared counter in the database.
// Real local MongoDB (test/helpers/realMongo.js; skipped, with the reason, without one). Mail is captured, DNS is stood in
// for, no .env is read, nothing is sent.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM', 'MAIL_DAILY_CAP', 'MAIL_BULK_SHARE']) delete process.env[name];
delete process.env.VERCEL;
process.env.NODE_ENV = 'test';
process.env.SIGNUP_MODE = 'open';
process.env.PUBLIC_APP_URL = 'https://warden.test';

const mails = [];
const emailPath = require.resolve('../utils/email');
const realEmail = require('../utils/email');
const realSend = realEmail.sendEmail;
require.cache[emailPath].exports = { ...realEmail, sendEmail: async (message) => { mails.push(message); return true; } };

const { connectThrowaway, disconnectThrowaway, throwawayUri, mongoose } = require('./helpers/realMongo');
const { call } = require('./helpers/fakeDb');
const { makeUser } = require('./helpers/makeUser');
const dns = require('node:dns').promises;
const realDns = { resolveMx: dns.resolveMx, resolve4: dns.resolve4, resolve6: dns.resolve6 };

const { signupStart, signupVerify, SIGNUP_BUSY } = require('../controllers/signup.controller');
const { templates, MAIL_CLASS } = require('../utils/emailTemplates');
const { reserveMail, bulkMailOpen, mailSentToday, bulkLimit, mailCap, resetMailReports } = require('../utils/mailBudget');
const { PRIVACY_POLICY_VERSION } = require('../utils/policyVersion');
const { runReminders } = require('../utils/reminders');
const { forgetDomains } = require('../utils/emailDomain');
const { ipKey } = require('../utils/clientIp');
const { resetSecurityLogSampling } = require('../utils/securityLog');
const User = require('../models/User');
const OtpChallenge = require('../models/OtpChallenge');
const RateLimit = require('../models/RateLimit');
const ReminderLog = require('../models/ReminderLog');

const PASSWORD = 'Qx7!vTr29#mLpw';
let connected = { ok: false, reason: '' };
test.before(async () => {
  connected = await connectThrowaway('consent_mailcap');
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
    resetMailReports();
    resetSecurityLogSampling();
    dns.resolveMx = async () => [{ exchange: 'mx.example.com', priority: 10 }];
    delete process.env.MAIL_DAILY_CAP;
    delete process.env.MAIL_BULK_SHARE;
    return fn(context);
  });

const start = (body, ip = '203.0.113.5') => call(signupStart, { body: { password: PASSWORD, ...body }, ip });
const verify = (email, code) => call(signupVerify, { body: { email, password: PASSWORD, code }, ip: '203.0.113.5', headers: { 'user-agent': 'Mozilla/5.0 Chrome/126.0' } });
const codeIn = (mail) => /(?<![\d-])(\d{6})(?![\d-])/.exec(mail.text)[1];

// ---------------- A: consent ----------------

it('sign-up without an agreement is refused by the server, whatever the form says', async () => {
  for (const termsAccepted of [undefined, false, 'true', 1, null, 'yes']) {
    const out = await start({ email: 'no.consent@example.com', ...(termsAccepted === undefined ? {} : { termsAccepted }) });
    assert.equal(out.error?.status, 400, `termsAccepted=${JSON.stringify(termsAccepted)}`);
    assert.match(out.error.message, /agree to the Terms of use and the Privacy policy/);
  }
  assert.equal(await OtpChallenge.countDocuments({}), 0, 'no pending code was made');
  assert.equal(mails.length, 0, 'no mail was sent');
  assert.equal(await User.countDocuments({}), 0);
});

it('the agreement travels with the pending code and is written to the new account with the policy version', async () => {
  const before = Date.now();
  assert.equal((await start({ email: 'agreed@example.com', termsAccepted: true })).error, null);
  const pending = await OtpChallenge.findOne({}).lean();
  assert.equal(pending.consent.policyVersion, PRIVACY_POLICY_VERSION);
  assert.ok(pending.consent.acceptedAt instanceof Date && pending.consent.acceptedAt.getTime() >= before - 1000);
  assert.equal(await User.countDocuments({}), 0, 'still no account');

  const out = await verify('agreed@example.com', codeIn(mails[0]));
  assert.equal(out.error, null);
  const user = await User.findOne({ email: 'agreed@example.com' }).lean();
  assert.deepEqual(Object.keys(user.consent).sort(), ['acceptedAt', 'policyVersion']);
  assert.equal(user.consent.policyVersion, PRIVACY_POLICY_VERSION);
  assert.ok(user.consent.acceptedAt.getTime() >= before - 1000 && user.consent.acceptedAt.getTime() <= Date.now() + 1000);
  assert.ok(!JSON.stringify(out.json).includes('consent'), 'the sign-up answer does not echo it');
});

it('a pending code with no consent record cannot create an account (start again)', async () => {
  await start({ email: 'old.pending@example.com', termsAccepted: true });
  await OtpChallenge.updateOne({}, { $unset: { consent: 1 } });
  const out = await verify('old.pending@example.com', codeIn(mails[0]));
  assert.equal(out.error?.status, 401);
  assert.equal(await User.countDocuments({}), 0);
});

it('accounts made before consent was recorded have no consent field, and nothing adds one', async () => {
  const user = await makeUser(User, 'before.consent@example.com', PASSWORD);
  const raw = await User.collection.findOne({ _id: user._id });
  assert.ok(!('consent' in raw), 'no invented record');
  const read = await User.findOne({ _id: user._id }).lean();
  assert.equal(read.consent, undefined);
});

// ---------------- B: the daily mail budget ----------------

function withSmtp(fn) {
  const sent = [];
  const nodemailer = require('nodemailer');
  const realCreate = nodemailer.createTransport;
  nodemailer.createTransport = () => ({ sendMail: async (message) => { sent.push(message); return { messageId: 'x' }; } });
  Object.assign(process.env, { SMTP_HOST: 'smtp.sink.invalid', SMTP_PORT: '465', SMTP_USER: 'sender@sink.invalid', SMTP_PASS: 'not-a-real-password', MAIL_FROM: 'Warden <sender@sink.invalid>' });
  return Promise.resolve(fn(sent)).finally(() => {
    nodemailer.createTransport = realCreate;
    for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']) delete process.env[name];
  });
}
// The module caches its transporter; a fresh copy per test keeps the stub in force.
const freshSend = () => {
  delete require.cache[emailPath];
  const fresh = require('../utils/email');
  require.cache[emailPath].exports = { ...realEmail, sendEmail: async (message) => { mails.push(message); return true; } };
  return fresh.sendEmail;
};

it('bulk mail stops at its share of the daily cap while priority mail goes on to the cap', async () => {
  process.env.MAIL_DAILY_CAP = '10';
  process.env.MAIL_BULK_SHARE = '0.5';
  assert.equal(bulkLimit(), 5);
  await withSmtp(async (sent) => {
    const send = freshSend();
    const bulkResults = [];
    for (let i = 0; i < 8; i += 1) bulkResults.push(await send({ to: `bulk${i}@example.com`, ...templates.signupCode({ code: '123456', ttlMinutes: 5 }) }));
    assert.deepEqual(bulkResults, [true, true, true, true, true, false, false, false], 'bulk: 5 sent, the rest refused');
    assert.equal(await bulkMailOpen(), false);
    assert.equal(await mailSentToday(), 5, 'refused bulk mail does not use the counter');

    const priorityResults = [];
    for (let i = 0; i < 7; i += 1) priorityResults.push(await send({ to: `login${i}@example.com`, ...templates.signInCode({ code: '654321', ttlMinutes: 5 }) }));
    assert.deepEqual(priorityResults, [true, true, true, true, true, false, false], 'priority: the other 5 of the cap, then the cap');
    assert.equal(await mailSentToday(), 10);
    assert.equal(sent.length, 10, 'exactly the cap reached the provider');
    // And a sign-in code is still the kind of mail that goes while bulk is closed (checked above before the cap itself ran out).
  });
});

it('login codes still go out when bulk mail is already shut', async () => {
  process.env.MAIL_DAILY_CAP = '20';
  process.env.MAIL_BULK_SHARE = '0.5';
  await withSmtp(async (sent) => {
    const send = freshSend();
    for (let i = 0; i < bulkLimit(); i += 1) assert.equal(await reserveMail('bulk'), true);
    assert.equal(await send({ to: 'someone@example.com', ...templates.signupCode({ code: '111111', ttlMinutes: 5 }) }), false);
    assert.equal(await send({ to: 'someone@example.com', ...templates.signInCode({ code: '222222', ttlMinutes: 5 }) }), true);
    assert.equal(await send({ to: 'someone@example.com', ...templates.passwordResetCode({ code: '333333', ttlMinutes: 5 }) }), true);
    assert.equal(await send({ to: 'someone@example.com', ...templates.deleteAccountCode({ code: '444444', ttlMinutes: 5 }) }), true);
    assert.equal(await send({ to: 'someone@example.com', ...templates.newDevice({ browser: 'Chrome', os: 'Windows', country: 'PH', city: 'Manila', when: new Date() }) }), false, 'a new-device notice is bulk');
    assert.equal(sent.length, 3);
  });
});

it('every template says which budget it belongs to, and the codes people need to sign in are priority', () => {
  assert.deepEqual(Object.keys(MAIL_CLASS).sort(), Object.keys(templates).sort(), 'a new template must be classified');
  for (const name of Object.keys(templates)) assert.ok(['priority', 'bulk'].includes(MAIL_CLASS[name]), name);
  for (const name of ['signInCode', 'deleteAccountCode', 'passwordResetCode', 'emergencyOwnerSetupCode', 'emergencyContactRequestCode', 'emergencyContactSessionCode']) assert.equal(MAIL_CLASS[name], 'priority', name);
  for (const name of ['signupCode', 'signupAttempt', 'expiringDocuments', 'newDevice', 'trustedBrowser', 'shareCode']) assert.equal(MAIL_CLASS[name], 'bulk', name);
  assert.equal(templates.signupCode({ code: '123456', ttlMinutes: 5 }).mailClass, 'bulk');
  assert.equal(templates.signInCode({ code: '123456', ttlMinutes: 5 }).mailClass, 'priority');
});

it('when the budget is spent, sign-up start answers 503 with the same body for an address that has an account and one that has not', async () => {
  await makeUser(User, 'taken@example.com', PASSWORD);
  for (let i = 0; i < bulkLimit(); i += 1) assert.equal(await reserveMail('bulk'), true);
  assert.equal(await bulkMailOpen(), false);

  const known = await start({ email: 'taken@example.com', termsAccepted: true });
  const unknown = await start({ email: 'never.seen@example.com', termsAccepted: true });
  for (const out of [known, unknown]) {
    assert.equal(out.error.status, 503);
    assert.equal(out.error.message, SIGNUP_BUSY);
  }
  assert.deepEqual({ ...known.error }, { ...unknown.error }, 'the same error, field for field');
  assert.equal(mails.length, 0, 'no code and no "someone tried to sign up" notice');
  assert.equal(await OtpChallenge.countDocuments({}), 0);

  // Through the real error handler the body is the same fixed text for everyone too.
  const { errorHandler } = require('../middleware/errorHandler');
  const bodies = [known, unknown].map((out) => {
    let sentBody;
    errorHandler(out.error, {}, { status() { return this; }, json(body) { sentBody = body; } }, () => {});
    return sentBody;
  });
  assert.deepEqual(bodies[0].error.message, bodies[1].error.message);
  assert.equal(bodies[0].error.message, SIGNUP_BUSY);
  assert.equal(bodies[0].error.status, 503);
});

it('the day counter is shared by every instance: two separate processes cannot together pass the cap', async () => {
  const uri = throwawayUri('consent_mailcap');
  const script = `
    const Module = require('module'); const L = Module._load;
    Module._load = function (r, ...a) { return r === 'dotenv' ? { config: () => ({}) } : L.call(this, r, ...a); };
    process.env.NODE_ENV = 'test';
    Object.assign(process.env, { SMTP_HOST: 'smtp.sink.invalid', SMTP_PORT: '465', SMTP_USER: 's@sink.invalid', SMTP_PASS: 'x', MAIL_FROM: 'W <s@sink.invalid>', MAIL_DAILY_CAP: '20', MAIL_BULK_SHARE: '1' });
    const nodemailer = require(${JSON.stringify(require.resolve('nodemailer'))});
    let sent = 0;
    nodemailer.createTransport = () => ({ sendMail: async () => { sent += 1; } });
    const mongoose = require(${JSON.stringify(require.resolve('mongoose'))});
    (async () => {
      await mongoose.connect(${JSON.stringify(uri)}, { serverSelectionTimeoutMS: 3000 });
      const { sendEmail } = require(${JSON.stringify(emailPath)});
      const { templates } = require(${JSON.stringify(require.resolve('../utils/emailTemplates'))});
      const results = await Promise.all(Array.from({ length: 15 }, (_, i) => sendEmail({ to: 'p' + i + '@example.com', ...templates.signInCode({ code: '123456', ttlMinutes: 5 }) })));
      console.log('SENT:' + results.filter(Boolean).length + ':' + sent);
      await mongoose.disconnect();
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..') });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', () => resolve(out));
    child.on('error', reject);
  });
  const [a, b] = await Promise.all([run(), run()]);
  const count = (text) => Number(/SENT:(\d+):(\d+)/.exec(text)?.[1] ?? NaN);
  assert.ok(Number.isFinite(count(a)) && Number.isFinite(count(b)), `children: ${a} ${b}`);
  assert.equal(count(a) + count(b), 20, 'two instances sent exactly the cap together (30 tried)');
  const row = await RateLimit.findOne({ bucket: 'mail-daily' }).lean();
  assert.equal(row.count, 20);
});

it('a failing counter never costs anybody a login code', async () => {
  const original = RateLimit.findOneAndUpdate;
  RateLimit.findOneAndUpdate = () => { throw new Error('database hiccup'); };
  try {
    assert.equal(await reserveMail('priority'), true);
    assert.equal(await reserveMail('bulk'), true);
  } finally {
    RateLimit.findOneAndUpdate = original;
  }
});

it('the daily reminder job stops when bulk mail is used up, sends nothing, and reports how many accounts it skipped', async () => {
  const users = [];
  for (let i = 0; i < 3; i += 1) users.push(await makeUser(User, `reminder${i}@example.com`, PASSWORD));
  const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
  for (const user of users) {
    await mongoose.connection.db.collection('documents').insertOne({ userId: user._id, deletedAt: null, docExpiresAt: soon, filename: 'x', createdAt: new Date() });
  }
  for (let i = 0; i < bulkLimit(); i += 1) await reserveMail('bulk');
  const logged = [];
  const realLog = console.log;
  console.log = (...args) => { logged.push(args.join(' ')); };
  let result;
  try {
    result = await runReminders({});
  } finally {
    console.log = realLog;
  }
  assert.equal(result.emails, 0);
  assert.equal(result.skippedMailCap, 3);
  assert.equal(result.remaining, true);
  assert.equal(await ReminderLog.countDocuments({}), 0, 'nothing was claimed, so the next run tries them again');
  assert.match(logged.join('\n'), /3 accounts skipped \(daily mail budget\)/);
  assert.ok(!/@/.test(logged.join('\n')), 'counts only, no address');
});

// ---------------- the per-address and per-IP limits on /signup/start ----------------

it('/signup/start is limited per connection (10 an hour) before anything else, IPv6 by its /64, and per address (5 an hour)', async () => {
  assert.equal(ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), ipKey('2001:db8:1:2:1111:2222:3333:4444'), 'one /64 is one connection');
  assert.notEqual(ipKey('2001:db8:1:2::1'), ipKey('2001:db8:1:3::1'));

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth.routes'));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const post = async (email) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/signup/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, termsAccepted: true }),
    });
    await response.text();
    return response.status;
  };
  try {
    const statuses = [];
    for (let i = 0; i < 12; i += 1) statuses.push(await post(`person${i}@example.com`)); // eslint-disable-line no-await-in-loop
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200), 'ten different addresses from one connection are fine');
    assert.deepEqual(statuses.slice(10), [429, 429], 'the eleventh in the hour is refused');
    await RateLimit.deleteMany({});
    const same = [];
    for (let i = 0; i < 7; i += 1) same.push(await post('one.address@example.com')); // eslint-disable-line no-await-in-loop
    assert.equal(same.filter((s) => s === 429).length >= 1, true, 'one address cannot be asked for more than 5 codes an hour');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
