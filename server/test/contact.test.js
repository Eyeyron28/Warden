const test = require('node:test');
const assert = require('node:assert/strict');

const { startLiveApp } = require('./helpers/liveApp');

let live = { ok: false, reason: '' };
let CONTACT_RECIPIENT;
test.before(async () => {
  live = await startLiveApp('contact');
  ({ CONTACT_RECIPIENT } = require('../controllers/contact.controller'));
});
test.after(async () => {
  if (live.ok) await live.stop();
});

const it = (name, fn) =>
  test(name, async (context) => {
    if (!live.ok) return context.skip(live.reason);
    return fn(context);
  });

const valid = { name: 'Ada Lovelace', email: 'ada@example.com', message: 'Hello, I have a question about sharing.', website: '' };
const post = (json, options = {}) => live.api('POST', '/api/contact', { json, ...options });
const contactMails = () => live.mails.filter((mail) => mail.subject === 'Warden contact form');

it('the recipient is fixed in the code', () => {
  assert.equal(CONTACT_RECIPIENT, 'warden.vault.app@gmail.com');
});

it('a valid message is sent once, to the fixed address, with the sender as Reply-To', async () => {
  const before = contactMails().length;
  const response = await post(valid);
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.body, { success: true });
  const mails = contactMails();
  assert.equal(mails.length, before + 1);
  const mail = mails.at(-1);
  assert.equal(mail.to, CONTACT_RECIPIENT);
  assert.equal(mail.replyTo, 'ada@example.com');
  assert.equal(mail.subject, 'Warden contact form');
  assert.match(mail.text, /Hello, I have a question about sharing\./);
  assert.match(mail.text, /Ada Lovelace/);
});

it('the message is escaped in the HTML part, not interpreted', async () => {
  const response = await post({ ...valid, message: '<script>alert(1)</script> hi', email: 'esc@example.com' });
  assert.equal(response.status, 200, response.text);
  const mail = contactMails().at(-1);
  assert.ok(!mail.html.includes('<script>alert(1)</script>'));
});

it('invalid inputs are refused and send nothing', async () => {
  const before = contactMails().length;
  const cases = [
    {},
    { ...valid, name: '' },
    { ...valid, name: 'x'.repeat(101) },
    { ...valid, email: 'not-an-email' },
    { ...valid, email: '' },
    { ...valid, message: '' },
    { ...valid, message: '   ' },
    { ...valid, message: 'x'.repeat(2001) },
    { ...valid, name: 42 },
    { ...valid, message: ['a'] },
  ];
  for (const body of cases) {
    const response = await post(body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal(contactMails().length, before);
});

it('the limits are the ones on the page: 100 characters of name, 2000 of message', async () => {
  const response = await post({ ...valid, name: 'n'.repeat(100), message: 'm'.repeat(2000), email: 'limits@example.com' });
  assert.equal(response.status, 200, response.text);
});

it('line breaks in the name never reach a header, and a break in the email is refused', async () => {
  const before = contactMails().length;
  const named = await post({ ...valid, email: 'inject1@example.com', name: 'Eve\r\nBcc: victim@example.com' });
  assert.equal(named.status, 200, named.text);
  const mail = contactMails().at(-1);
  assert.equal(mail.to, CONTACT_RECIPIENT);
  assert.ok(!('bcc' in mail) && !('cc' in mail) && !('headers' in mail));
  assert.ok(!/[\r\n]/.test(mail.replyTo));
  assert.equal(mail.subject, 'Warden contact form');

  const injected = await post({ ...valid, email: 'inject2@example.com\r\nBcc: victim@example.com' });
  assert.equal(injected.status, 400, injected.text);
  const encoded = await post({ ...valid, email: 'inject3@example.com%0d%0aBcc:victim@example.com' });
  assert.equal(encoded.status, 400, encoded.text);
  assert.equal(contactMails().length, before + 1);
});

it('the request cannot choose the recipient, the subject or the reply address header', async () => {
  const response = await post({
    ...valid,
    email: 'choose@example.com',
    to: 'attacker@example.com',
    recipient: 'attacker@example.com',
    cc: 'attacker@example.com',
    bcc: 'attacker@example.com',
    subject: 'Something else',
    replyTo: 'attacker@example.com',
  });
  assert.equal(response.status, 200, response.text);
  const mail = contactMails().at(-1);
  assert.equal(mail.to, CONTACT_RECIPIENT);
  assert.equal(mail.subject, 'Warden contact form');
  assert.equal(mail.replyTo, 'choose@example.com');
  assert.ok(!('cc' in mail) && !('bcc' in mail));
});

it('a filled honeypot looks like success and sends nothing', async () => {
  const before = contactMails().length;
  const response = await post({ ...valid, email: 'bot@example.com', website: 'https://spam.example' });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.body, { success: true });
  assert.equal(contactMails().length, before);
});

it('three messages per hour per address; the fourth is refused, another address still works', async () => {
  const { mongoose } = live;
  await mongoose.models.RateLimit.deleteMany({});
  const before = contactMails().length;
  const email = 'repeat@example.com';
  for (let i = 0; i < 3; i += 1) {
    await mongoose.models.RateLimit.deleteMany({ bucket: 'contact-ip' });
    assert.equal((await post({ ...valid, email }, { keepLimits: true })).status, 200);
  }
  await mongoose.models.RateLimit.deleteMany({ bucket: 'contact-ip' });
  const fourth = await post({ ...valid, email: 'REPEAT@example.com' }, { keepLimits: true });
  assert.equal(fourth.status, 429, fourth.text);
  assert.equal(contactMails().length, before + 3);
  await mongoose.models.RateLimit.deleteMany({ bucket: 'contact-ip' });
  assert.equal((await post({ ...valid, email: 'someone.else@example.com' }, { keepLimits: true })).status, 200);
});

it('three messages per hour per connection; the fourth is refused whatever the address', async () => {
  const { mongoose } = live;
  await mongoose.models.RateLimit.deleteMany({});
  const before = contactMails().length;
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await post({ ...valid, email: `ip${i}@example.com` }, { keepLimits: true })).status, 200);
  }
  const fourth = await post({ ...valid, email: 'ip9@example.com' }, { keepLimits: true });
  assert.equal(fourth.status, 429, fourth.text);
  assert.equal(contactMails().length, before + 3);
});

it('a send failure gives the generic message with a request id, and the body is never logged', async () => {
  const { mongoose } = live;
  await mongoose.models.RateLimit.deleteMany({});
  const secret = 'SECRET-BODY-TEXT-9f3a';
  const logged = [];
  const originals = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...args) => logged.push(args.join(' '));
  console.error = (...args) => logged.push(args.join(' '));
  console.warn = (...args) => logged.push(args.join(' '));
  const push = live.mails.push;
  live.mails.push = () => {
    throw new Error('mail server down');
  };
  let failed;
  let ok;
  try {
    failed = await post({ ...valid, email: 'fail@example.com', message: secret });
    live.mails.push = push;
    await mongoose.models.RateLimit.deleteMany({});
    ok = await post({ ...valid, email: 'fine@example.com', message: secret });
  } finally {
    live.mails.push = push;
    Object.assign(console, originals);
  }
  assert.equal(failed.status, 502, failed.text);
  assert.equal(failed.body.error.message, 'Something went wrong on our side. Please try again.');
  assert.match(failed.body.error.requestId, /^[0-9a-f]+$/);
  assert.equal(ok.status, 200, ok.text);
  assert.ok(!logged.some((entry) => entry.includes(secret)), 'the message body is not logged');
});
