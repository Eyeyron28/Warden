const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.PUBLIC_APP_URL = 'https://warden.test';

const { templates, appLink } = require('../utils/emailTemplates');
const email = require('../utils/email');

const CODE = '482916';
const code = (name, ttlMinutes = 5) => templates[name]({ code: CODE, ttlMinutes });
const CODE_TEMPLATES = ['signInCode', 'deleteAccountCode', 'passwordResetCode', 'passwordChangeCode', 'shareCode', 'signupCode', 'emergencyContactRequestCode', 'emergencyContactSessionCode', 'emergencyOwnerSetupCode'];

test('every email that carries a code has no link and no image, a plain-text part, and the code only in the body', () => {
  for (const name of CODE_TEMPLATES) {
    const mail = code(name);
    assert.ok(mail.text.includes(CODE), name);
    assert.ok(mail.html.includes(CODE), name);
    assert.ok(mail.text.length > 20 && mail.html.length > 200, `${name}: both parts`);
    assert.doesNotMatch(mail.html, /<a[\s>]/i, `${name}: no <a>`);
    assert.doesNotMatch(mail.html, /<img[\s>]/i, `${name}: no <img>`);
    assert.doesNotMatch(mail.html, /href\s*=|src\s*=|url\(/i, `${name}: nothing that loads or links`);
    assert.doesNotMatch(mail.html + mail.text, /https?:\/\//i, `${name}: no address of any website`);
    assert.ok(!mail.subject.includes(CODE), `${name}: the subject does not carry the code`);
  }
});

test('the code templates listed here are all of the templates that take a code', () => {
  const taking = Object.entries(templates).filter(([, build]) => /^\(\{[^}]*\bcode\b/.test(build.toString().trim())).map(([name]) => name).sort();
  assert.deepEqual(taking, [...CODE_TEMPLATES].sort(), 'a new code email must be added to this list (and so to these checks)');
});

test('subjects: short, no exclamation marks, no shouting, no spam words, and one per purpose', () => {
  const samples = {
    ...Object.fromEntries(CODE_TEMPLATES.map((name) => [name, code(name)])),
    verifyEmailResend: templates.verifyEmailResend({ verifyUrl: 'https://warden.test/verify-email?token=x' }),
    signupAttempt: templates.signupAttempt({ when: new Date() }),
    passwordChanged: templates.passwordChanged({ method: 'recovery-key', when: new Date(), browser: 'Chrome' }),
  };
  const subjects = Object.entries(samples).map(([name, mail]) => [name, mail.subject]);
  for (const [name, subject] of subjects) {
    assert.ok(subject.length <= 60, `${name}: "${subject}" is ${subject.length} characters`);
    assert.doesNotMatch(subject, /!/, name);
    assert.doesNotMatch(subject, /\b[A-Z]{4,}\b/, `${name}: no all-caps words`);
    assert.doesNotMatch(subject, /\b(free|urgent|act now|verify now|winner|limited time)\b/i, `${name}: no spam words`);
  }
  const codeSubjects = CODE_TEMPLATES.map((name) => samples[name].subject);
  assert.equal(new Set(codeSubjects).size, codeSubjects.length, `unique per purpose: ${codeSubjects.join(' | ')}`);
  assert.equal(new Set(subjects.map(([, s]) => s)).size, subjects.length, 'and unique across the others');
});

test('the lifetime shown is the one passed in', () => {
  for (const name of CODE_TEMPLATES) {
    assert.match(code(name, 7).text, /expires in 7 minutes/, name);
    assert.match(code(name, 1).text, /expires in 1 minute\b/, name);
    assert.match(code(name, 7).html, /expires in 7 minutes/, name);
  }
});

test('notification emails keep at most one link, and only to the app’s own address', () => {
  const notes = [templates.signupAttempt({ when: new Date() }), templates.passwordChanged({ method: 'wipe', when: new Date(), browser: 'Chrome' })];
  for (const mail of notes) {
    const links = [...mail.html.matchAll(/<a[^>]+href="([^"]+)"/gi)].map((m) => m[1]);
    assert.ok(links.length <= 1, `${mail.subject}: ${links.length} links`);
    for (const link of links) assert.ok(link.startsWith(appLink('/').replace(/\/$/, '')), link);
    assert.doesNotMatch(mail.html, /<img[\s>]/i);
  }
});

test('From is exactly the authenticated SMTP user, with the display name Warden', () => {
  assert.deepEqual(email.fromHeader('Warden <someone.else@example.com>', 'sender@gmail.com'), { name: 'Warden', address: 'sender@gmail.com' });
  assert.deepEqual(email.fromHeader('no-reply@example.com', 'sender@gmail.com'), { name: 'Warden', address: 'sender@gmail.com' });
  assert.deepEqual(email.fromHeader('Anything <mail@example.com>', 'apikey'), { name: 'Warden', address: 'mail@example.com' });
  assert.deepEqual(email.fromHeader('Warden <mail@example.com>'), { name: 'Warden', address: 'mail@example.com' });
});

test('a MAIL_FROM that differs from SMTP_USER is warned about, without printing either address', () => {
  const warning = email.mailFromWarning({ SMTP_USER: 'sender@gmail.com', MAIL_FROM: 'Warden <other@example.com>' });
  assert.match(warning, /MAIL_FROM/);
  assert.match(warning, /SMTP_USER/);
  assert.ok(!/sender@|other@|@gmail|@example/i.test(warning), 'no address in the warning');
  assert.equal(email.mailFromWarning({ SMTP_USER: 'sender@gmail.com', MAIL_FROM: 'Warden <Sender@Gmail.com>' }), null, 'the same address, any case or display name');
  assert.equal(email.mailFromWarning({ SMTP_USER: 'apikey', MAIL_FROM: 'a@example.com' }), null, 'nothing to compare');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /mailFromWarning\(\)/, 'checked at start-up');
});

test('what is handed to the SMTP server: From = SMTP user, and the auto-generated headers', async () => {
  const sent = [];
  const nodemailerPath = require.resolve('nodemailer');
  const original = require.cache[nodemailerPath];
  require.cache[nodemailerPath] = { id: nodemailerPath, filename: nodemailerPath, loaded: true, exports: { createTransport: () => ({ sendMail: async (message) => { sent.push(message); } }) } };
  const savedEnv = { ...process.env };
  Object.assign(process.env, { SMTP_HOST: 'smtp.test', SMTP_PORT: '465', SMTP_USER: 'sender@gmail.com', SMTP_PASS: 'pw', MAIL_FROM: 'Warden <different@example.com>' });
  delete require.cache[require.resolve('../utils/email')];
  try {
    const fresh = require('../utils/email');
    assert.equal(await fresh.sendEmail({ to: 'person@example.com', ...code('signupCode') }), true);
    const [message] = sent;
    assert.deepEqual(message.from, { name: 'Warden', address: 'sender@gmail.com' });
    assert.equal(message.headers['Auto-Submitted'], 'auto-generated');
    assert.equal(message.headers['X-Auto-Response-Suppress'], 'All');
    assert.ok(message.text && message.html, 'multipart: plain text and HTML');
    assert.equal(message.to, 'person@example.com');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    require.cache[nodemailerPath] = original;
    delete require.cache[require.resolve('../utils/email')];
  }
});
