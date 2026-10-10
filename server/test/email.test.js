// Run with: cd server && npm test   (Node's built-in test runner, no deps)
const test = require('node:test');
const assert = require('node:assert/strict');

// Make sure the dev console fallback is what's under test, whatever is in .env.
for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']) {
  delete process.env[name];
}

const { sendEmail, isSafeRecipient } = require('../utils/email');

const GOOD = [
  'user@example.com',
  'first.last@example.com',
  'a+tag@sub.example.co.ph',
  "o'brien@example.com",
  'user_name-1@example-site.com',
  'x@a.io',
];

const BAD = [
  ['two recipients, comma', 'victim@example.com,attacker@evil.com'],
  ['comma in local part', 'a,b@evil.com'],
  ['semicolon list', 'victim@example.com;attacker@evil.com'],
  ['display name with angle brackets', 'Victim <victim@example.com>'],
  ['angle brackets around address', '<victim@example.com>'],
  ['address then angle brackets', 'attacker@evil.com<victim@example.com>'],
  ['quoted local part', '"victim"@example.com'],
  ['comment', 'victim@example.com(attacker@evil.com)'],
  ['CRLF header injection', 'victim@example.com\r\nBcc: attacker@evil.com'],
  ['bare LF', 'victim@example.com\nBcc: attacker@evil.com'],
  ['trailing newline', 'victim@example.com\n'],
  ['space inside', 'vic tim@example.com'],
  ['leading space', ' victim@example.com'],
  ['tab', 'victim@example.com\t'],
  ['null byte', 'victim@example.com\0'],
  ['non-ASCII in local part', 'viktoré@example.com'],
  ['non-ASCII (IDN) domain', 'user@bücher.example'],
  ['Cyrillic lookalike domain', 'user@еxample.com'],
  ['punycode domain', 'user@xn--bcher-kva.example'],
  ['two @', 'a@b@example.com'],
  ['no @', 'userexample.com'],
  ['no domain dot', 'user@localhost'],
  ['empty local part', '@example.com'],
  ['empty domain', 'user@'],
  ['leading dot in local part', '.user@example.com'],
  ['double dot in local part', 'us..er@example.com'],
  ['domain label with leading hyphen', 'user@-example.com'],
  ['domain label with trailing hyphen', 'user@example-.com'],
  ['empty domain label', 'user@example..com'],
  ['trailing dot domain', 'user@example.com.'],
  ['backslash', 'a\\b@example.com'],
  ['square-bracket IP literal', 'user@[127.0.0.1]'],
  ['over 254 characters', `${'a'.repeat(60)}@${`${'b'.repeat(60)}.`.repeat(4)}com`],
  ['local part over 64 characters', `${'a'.repeat(65)}@example.com`],
  ['empty string', ''],
  ['not a string: null', null],
  ['not a string: undefined', undefined],
  ['not a string: array', ['a@example.com']],
  ['not a string: object', { address: 'a@example.com' }],
  ['not a string: number', 12345],
];

test('isSafeRecipient accepts plain single addresses', () => {
  for (const address of GOOD) assert.equal(isSafeRecipient(address), true, address);
});

test('isSafeRecipient: 254 characters is the limit', () => {
  // 64 (local) + 1 (@) + 63 + 1 + 63 + 1 + 61 = 254, every label within 63.
  const at254 = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
  const at255 = `${at254}d`.replace(/d{62}$/, 'd'.repeat(62));
  assert.equal(at254.length, 254);
  assert.equal(isSafeRecipient(at254), true);
  assert.equal(at255.length, 255);
  assert.equal(isSafeRecipient(at255), false);
});

for (const [name, value] of BAD) {
  test(`isSafeRecipient rejects: ${name}`, () => {
    assert.equal(isSafeRecipient(value), false);
  });
}

function captureConsole(fn) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  return Promise.resolve(fn())
    .then((result) => ({ result, logs, errors }))
    .finally(() => {
      console.log = originalLog;
      console.error = originalError;
    });
}

test('sendEmail with SMTP unset logs the full email to the console (dev fallback)', async () => {
  const { result, logs, errors } = await captureConsole(() =>
    sendEmail({
      to: 'user@example.com',
      subject: 'Verify',
      text: 'Open https://warden.example/verify-email?token=abc123',
      html: '<p>Open https://warden.example/verify-email?token=abc123</p>',
    })
  );
  assert.equal(result, true);
  assert.equal(errors.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /DEV EMAIL/);
  assert.match(logs[0], /To: user@example\.com/);
  assert.match(logs[0], /token=abc123/);
});

test('sendEmail drops a hostile recipient before the console fallback or Nodemailer', async () => {
  const { result, logs, errors } = await captureConsole(() =>
    sendEmail({
      to: 'victim@example.com\r\nBcc: attacker@evil.com',
      subject: 'x',
      text: 'secret link',
      html: '<p>secret link</p>',
    })
  );
  assert.equal(result, false);
  assert.equal(logs.length, 0, 'the message body must not be logged for a rejected recipient');
  assert.equal(errors.length, 1);
  // Only the length is logged: no address, no CRLF, nothing that could start a forged log line.
  assert.match(errors[0], /Refusing to send email: invalid recipient \(\d+ characters\)\./);
  assert.doesNotMatch(errors[0], /\r|\n.*Bcc|victim|attacker|evil/);
});

test('sendEmail never throws, even for a non-string recipient', async () => {
  const { result } = await captureConsole(() => sendEmail({ to: { evil: true }, subject: 'x', text: 'y', html: '<p>y</p>' }));
  assert.equal(result, false);
});
