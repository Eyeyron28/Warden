const nodemailer = require('nodemailer');
const { reserveMail } = require('./mailBudget');

const { isProduction } = require('./runtimeEnv');
const { scrubForLog, shortHash } = require('./logSafe');

const SMTP_VARS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'];

const PLAIN_ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+$/;
const addressOf = (value) => {
  const match = /<([^<>]+)>\s*$/.exec(String(value || ''));
  return (match ? match[1] : String(value || '')).trim();
};

function fromHeader(configured, smtpUser) {
  const user = String(smtpUser || '').trim();
  if (PLAIN_ADDRESS.test(user)) return { name: 'Warden', address: user };
  const address = addressOf(configured);
  return PLAIN_ADDRESS.test(address) ? { name: 'Warden', address } : configured;
}

function mailFromWarning(env = process.env) {
  const user = String(env.SMTP_USER || '').trim().toLowerCase();
  const from = addressOf(env.MAIL_FROM).toLowerCase();
  if (!PLAIN_ADDRESS.test(user) || !PLAIN_ADDRESS.test(from) || user === from) return null;
  return 'MAIL_FROM names a different mailbox than SMTP_USER. Mail is sent from the SMTP_USER address (providers such as Gmail rewrite any other), so set MAIL_FROM to the same address.';
}

const TRANSACTIONAL_HEADERS = Object.freeze({ 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' });

function smtpConfigured() {
  return SMTP_VARS.every((name) => Boolean(process.env[name]));
}

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

const MAX_ADDRESS_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;

const LOCAL_PART_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

function isSafeRecipient(address) {
  if (typeof address !== 'string') return false;
  if (address.length < 3 || address.length > MAX_ADDRESS_LENGTH) return false;
  if (!/^[\x21-\x7E]+$/.test(address)) return false;

  const parts = address.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;

  if (!local || local.length > MAX_LOCAL_PART_LENGTH || !LOCAL_PART_RE.test(local)) return false;

  const labels = domain.split('.');
  if (labels.length < 2) return false;
  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      DOMAIN_LABEL_RE.test(label) &&
      !label.toLowerCase().startsWith('xn--')
  );
}

function normalizeRecipient(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return isSafeRecipient(trimmed) ? trimmed.toLowerCase() : null;
}

async function sendEmail({ to, subject, text, html, mailClass, replyTo, logBody = true }) {
  if (typeof subject !== 'string' || typeof text !== 'string' || typeof html !== 'string') {
    console.error('Refusing to send email: it must come from utils/emailTemplates.js (subject, text and html).');
    return false;
  }

  if (!isSafeRecipient(to)) {
    console.error(`Refusing to send email: invalid recipient (${String(to).length} characters).`);
    return false;
  }

  if (replyTo !== undefined && !isSafeRecipient(replyTo)) {
    console.error('Refusing to send email: invalid reply-to address.');
    return false;
  }

  if (!smtpConfigured()) {
    if (isProduction()) {
      console.error('SMTP is not configured in production; an email was not sent.');
      return false;
    }
    console.log(
      `\n--- DEV EMAIL (SMTP not configured, logging instead of sending) ---\nTo: ${to}\nSubject: ${subject}\n\n${logBody ? text : '(body not logged)'}\n--- END DEV EMAIL ---\n`
    );
    return true;
  }

  if (!(await reserveMail(mailClass === 'bulk' ? 'bulk' : 'priority'))) return false;

  try {
    await getTransporter().sendMail({
      from: fromHeader(process.env.MAIL_FROM, process.env.SMTP_USER),
      to,
      subject,
      text,
      html,
      ...(replyTo ? { replyTo } : {}),
      headers: TRANSACTIONAL_HEADERS,
    });
    return true;
  } catch (err) {
    console.error(`Failed to send email to recipient ${shortHash(to)}: ${scrubForLog(err.message)}`);
    return false;
  }
}

async function verifySmtp() {
  if (!smtpConfigured()) {
    throw new Error(`SMTP is not configured: set ${SMTP_VARS.join(', ')}.`);
  }
  return getTransporter().verify();
}

module.exports = { sendEmail, isSafeRecipient, normalizeRecipient, verifySmtp, fromHeader, mailFromWarning, TRANSACTIONAL_HEADERS };
