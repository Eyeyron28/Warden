// Sends one sample of EVERY Warden email to an address you choose, so each template can be
// checked in a real inbox (desktop and phone, light and dark mode).
//
//   cd server && node scripts/send-test-emails.js you@example.com
//   node scripts/send-test-emails.js you@example.com --save ./email-preview   (also writes .html/.txt files)
//   node scripts/send-test-emails.js --save ./email-preview                   (write files only, send nothing)
//
// Uses the SMTP settings in server/.env (never printed). With SMTP unset it logs to the console
// like the app does in development. It refuses to run in production (NODE_ENV=production or on
// Vercel) unless --force is given, because it sends real mail from the production account.
// The codes in the samples are fixed examples, not real codes.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');

const { isProduction } = require('../utils/runtimeEnv');
const { sendEmail } = require('../utils/email');
const { templates } = require('../utils/emailTemplates');
const { otpTtlMinutes } = require('../utils/otpConfig');

const args = process.argv.slice(2);
const force = args.includes('--force');
const saveIndex = args.indexOf('--save');
const saveDir = saveIndex >= 0 ? args[saveIndex + 1] : null;
const recipient = args.find((arg, i) => !arg.startsWith('--') && i !== saveIndex + 1);

if (isProduction() && !force) {
  console.error('Refusing to send test emails in production. Pass --force if you really mean it.');
  process.exit(1);
}
if (!recipient && !saveDir) {
  console.error('Usage: node scripts/send-test-emails.js <recipient> [--save <dir>] [--force]');
  process.exit(1);
}

const ttlMinutes = otpTtlMinutes();
const when = new Date();
const verifyUrl = `${(process.env.PUBLIC_APP_URL || 'https://warden.example.com').replace(/\/$/, '')}/verify-email?token=EXAMPLE-NOT-A-REAL-TOKEN`;

const samples = [
  ['sign-in-code', templates.signInCode({ code: '482916', ttlMinutes })],
  ['delete-account-code', templates.deleteAccountCode({ code: '482916', ttlMinutes })],
  ['password-reset-code', templates.passwordResetCode({ code: '482916', ttlMinutes })],
  ['share-code', templates.shareCode({ code: '482916', ttlMinutes })],
  ['verify-email', templates.verifyEmail({ verifyUrl })],
  ['verify-email-resend', templates.verifyEmailResend({ verifyUrl })],
  ['signup-attempt', templates.signupAttempt({ when })],
  ['password-changed-recovery-key', templates.passwordChanged({ method: 'recovery-key', when, browser: 'Chrome on Windows' })],
  ['password-changed-wipe', templates.passwordChanged({ method: 'wipe', when, browser: 'Chrome on Android' })],
  ['account-deleted', templates.accountDeleted({ when })],
  ['new-device', templates.newDevice({ browser: 'Chrome', os: 'Windows', country: 'PH', city: 'Manila', when })],
  ['trusted-browser', templates.trustedBrowser({ browser: 'Chrome on Windows', when })],
];

(async () => {
  if (saveDir) {
    fs.mkdirSync(saveDir, { recursive: true });
    for (const [name, mail] of samples) {
      fs.writeFileSync(path.join(saveDir, `${name}.html`), mail.html);
      fs.writeFileSync(path.join(saveDir, `${name}.txt`), `Subject: ${mail.subject}\n\n${mail.text}`);
    }
    console.log(`Wrote ${samples.length} samples to ${saveDir}`);
  }
  if (!recipient) return;
  let sent = 0;
  for (const [name, mail] of samples) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await sendEmail({ to: recipient, ...mail, subject: `[test] ${mail.subject}` });
    console.log(`${ok ? 'sent  ' : 'FAILED'} ${name}: ${mail.subject}`);
    if (ok) sent += 1;
  }
  console.log(`${sent} of ${samples.length} sent to ${recipient}.`);
  process.exitCode = sent === samples.length ? 0 : 1;
})();
