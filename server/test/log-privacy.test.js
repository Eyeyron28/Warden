// Run with: cd server && npm test
//
// F15: the server log never carries a recipient's email address. A failed send names the recipient by a short hash and
// repeats the provider's error with any address scrubbed out; an invalid recipient is logged by length only.
const test = require('node:test');
const assert = require('node:assert/strict');

for (const [name, value] of Object.entries({ SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'Warden <no-reply@example.test>' })) process.env[name] = value;
process.env.NODE_ENV = 'test';

// A mail transport that always fails the way real SMTP servers do: with the recipient's address in the message.
const nodemailerPath = require.resolve('nodemailer');
require.cache[nodemailerPath] = {
  id: nodemailerPath, filename: nodemailerPath, loaded: true,
  exports: { createTransport: () => ({ sendMail: async ({ to }) => { throw new Error(`550 5.1.1 <${to}>: Recipient address rejected: User unknown in virtual mailbox table`); } }) },
};
const { sendEmail } = require('../utils/email');
const { shortHash, scrubForLog } = require('../utils/logSafe');
const { templates } = require('../utils/emailTemplates');

test('a failed send logs the recipient as a short hash, and the provider text with the address scrubbed', async (context) => {
  const lines = [];
  context.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  const sent = await sendEmail({ to: 'Victim.Person@Example.com', ...templates.signInCode({ code: '123456', ttlMinutes: 10 }) });
  assert.equal(sent, false);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(shortHash('victim.person@example.com')), 'identified by hash');
  assert.ok(!/victim/i.test(lines[0]), 'no part of the address');
  assert.ok(!/example\.com/i.test(lines[0]));
  assert.ok(!lines[0].includes('123456'), 'and never the message');
});

test('shortHash is stable, case-insensitive and short; scrubForLog removes addresses and connection strings', () => {
  assert.equal(shortHash('A@B.com'), shortHash(' a@b.com '));
  assert.match(shortHash('a@b.com'), /^[0-9a-f]{8}$/);
  assert.notEqual(shortHash('a@b.com'), shortHash('c@d.com'));
  const text = scrubForLog('failed for someone@example.org via mongodb+srv://user:pw@cluster0.example.net/db?x=1');
  assert.ok(!text.includes('someone') && !text.includes('user:pw') && !text.includes('cluster0'));
});
