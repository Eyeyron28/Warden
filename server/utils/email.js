const nodemailer = require('nodemailer');

const { isProduction } = require('./runtimeEnv');
const { scrubForLog, shortHash } = require('./logSafe');

/**
 * Thin Nodemailer wrapper, configured entirely from env (SMTP_HOST,
 * SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM). The transporter is built
 * once, lazily, at module scope - same "cache across invocations, don't
 * rebuild per request" reasoning as the Mongo connection in config/db.js.
 *
 * Dev fallback: if SMTP_PASS (or any SMTP var) is empty, nothing is ever
 * actually sent over the network - the full email (including the
 * verification/reset link, which is the only part anyone developing
 * locally actually needs) is logged to the server console instead. This
 * is what lets every auth flow in this app be exercised locally without a
 * real mailbox.
 */

const SMTP_VARS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'];

/** The From header with the display name "Warden", whatever name (if any) MAIL_FROM carried. */
function fromHeader(configured) {
  const match = /<([^<>]+)>\s*$/.exec(String(configured || ''));
  const address = (match ? match[1] : String(configured || '')).trim();
  return /^[^\s@<>"]+@[^\s@<>"]+$/.test(address) ? { name: 'Warden', address } : configured;
}

function smtpConfigured() {
  return SMTP_VARS.every((name) => Boolean(process.env[name]));
}

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      // Port 465 is implicit TLS; everything else (587, 25) starts plain
      // and upgrades via STARTTLS, which Nodemailer does on its own when
      // `secure` is false - this is standard SMTP-port convention, not a
      // Warden-specific choice.
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

const MAX_ADDRESS_LENGTH = 254; // RFC 5321 path limit
const MAX_LOCAL_PART_LENGTH = 64;

// Letters, digits and the RFC 5322 "atext" punctuation - deliberately
// WITHOUT the characters that give an address list its structure or let it
// carry a display name or comment: , ; : < > ( ) [ ] \ " @ and whitespace.
const LOCAL_PART_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/**
 * True only for ONE plain ASCII mailbox like `name@example.com`.
 *
 * Nodemailer's `to` accepts a whole address list ("a@x.com, Bob <b@y.com>"),
 * so a value that merely looks like an email to a loose check can address
 * extra recipients: `victim@example.com,attacker@evil.com` or
 * `attacker@evil.com <victim@example.com>`. This rejects anything that
 * isn't exactly one address - no commas, angle brackets, quotes, comments,
 * whitespace or control characters (so no CRLF header injection), no
 * non-ASCII text and no internationalised/punycode (`xn--`) domains (the
 * Unicode-lookalike class of delivery-to-the-wrong-domain bugs), and nothing
 * over 254 characters. Plain, unmistakable addresses only.
 *
 * @param {unknown} address
 * @returns {boolean}
 */
function isSafeRecipient(address) {
  if (typeof address !== 'string') return false;
  if (address.length < 3 || address.length > MAX_ADDRESS_LENGTH) return false;
  // Printable ASCII only: rules out whitespace, CR/LF, other controls and
  // every non-ASCII character in one check.
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

/**
 * The one place an email address typed by a person becomes the canonical
 * address we store, look up and mail: trimmed, validated as a single plain
 * address (isSafeRecipient), then lowercased. Returns null for anything
 * that isn't one.
 *
 * Validation runs on the trimmed value BEFORE lowercasing, on purpose:
 * toLowerCase() can turn some non-ASCII characters into ASCII (the Kelvin
 * sign U+212A becomes "k"), which would let a lookalike address pass an
 * ASCII-only check as a different, clean-looking address. Leading and
 * trailing whitespace (including a trailing CRLF) is trimmed, as it always
 * was; anything inside the address that isn't allowed is a rejection.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeRecipient(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return isSafeRecipient(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * Sends one email, or logs it to the console if SMTP isn't configured.
 * Never throws - every caller in this app sends emails from anti-
 * enumeration flows (signup, forgot-password) where the HTTP response must
 * be identical whether or not the send actually succeeded, so a failure
 * here is logged for the operator and otherwise swallowed rather than
 * surfaced to the caller.
 *
 * The recipient is validated first (isSafeRecipient) and a bad one is
 * dropped before Nodemailer - or the console fallback - ever sees it.
 *
 * @param {{ to: string, subject: string, text: string, html?: string }} params
 * @returns {Promise<boolean>} whether the email was handed off (or logged)
 */
async function sendEmail({ to, subject, text, html }) {
  // Every message is built by utils/emailTemplates.js, which always provides both parts.
  if (typeof subject !== 'string' || typeof text !== 'string' || typeof html !== 'string') {
    console.error('Refusing to send email: it must come from utils/emailTemplates.js (subject, text and html).');
    return false;
  }

  if (!isSafeRecipient(to)) {
    // Only the length is logged: what was typed can be somebody's address (or a hostile string), and neither belongs in a log.
    console.error(`Refusing to send email: invalid recipient (${String(to).length} characters).`);
    return false;
  }

  if (!smtpConfigured()) {
    if (isProduction()) {
      // Never print an email body in production: it can carry a login code or
      // a reset link, which are credentials. Say only that nothing was sent.
      console.error('SMTP is not configured in production; an email was not sent.');
      return false;
    }
    // Dev fallback - the full email, verification/reset link or login code
    // included, so local development never needs a real mailbox. Never logs
    // SMTP_* (there's nothing to log here, by construction: this branch only
    // runs when none of them are usably set).
    console.log(
      `\n--- DEV EMAIL (SMTP not configured, logging instead of sending) ---\nTo: ${to}\nSubject: ${subject}\n\n${text}\n--- END DEV EMAIL ---\n`
    );
    return true;
  }

  try {
    await getTransporter().sendMail({
      from: fromHeader(process.env.MAIL_FROM),
      to,
      subject,
      text,
      html,
    });
    return true;
  } catch (err) {
    // Deliberately not rethrown - see function comment. Logs the failure
    // reason for operator visibility, never the SMTP credentials
    // themselves (err.message from Nodemailer/the SMTP server doesn't
    // include SMTP_PASS - only the auth outcome).
    // The recipient is identified by a short hash only, and the provider's message is scrubbed (SMTP errors often repeat the address).
    console.error(`Failed to send email to recipient ${shortHash(to)}: ${scrubForLog(err.message)}`);
    return false;
  }
}

/**
 * Checks the SMTP settings by opening a connection and authenticating
 * (nodemailer's transport.verify()), without sending anything. Used by
 * scripts/verify-smtp.js, never on a request path. Rejects with the
 * underlying error if SMTP isn't configured or the server refuses.
 */
async function verifySmtp() {
  if (!smtpConfigured()) {
    throw new Error(`SMTP is not configured: set ${SMTP_VARS.join(', ')}.`);
  }
  return getTransporter().verify();
}

module.exports = { sendEmail, isSafeRecipient, normalizeRecipient, verifySmtp, fromHeader };
