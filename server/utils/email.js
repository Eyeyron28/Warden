const nodemailer = require('nodemailer');

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

/**
 * Sends one email, or logs it to the console if SMTP isn't configured.
 * Never throws on a send failure - every caller in this app sends emails
 * from anti-enumeration flows (signup, forgot-password) where the HTTP
 * response must be identical whether or not the send actually succeeded,
 * so a failure here is logged for the operator and otherwise swallowed
 * rather than surfaced to the caller.
 *
 * @param {{ to: string, subject: string, text: string, html?: string }} params
 */
async function sendEmail({ to, subject, text, html }) {
  if (!smtpConfigured()) {
    // Dev fallback - the full email, verification/reset link included, so
    // local development never needs a real mailbox. Never logs SMTP_*
    // (there's nothing to log here, by construction: this branch only
    // runs when none of them are usably set).
    console.log(
      `\n--- DEV EMAIL (SMTP not configured, logging instead of sending) ---\nTo: ${to}\nSubject: ${subject}\n\n${text}\n--- END DEV EMAIL ---\n`
    );
    return;
  }

  try {
    await getTransporter().sendMail({
      from: process.env.MAIL_FROM,
      to,
      subject,
      text,
      html,
    });
  } catch (err) {
    // Deliberately not rethrown - see function comment. Logs the failure
    // reason for operator visibility, never the SMTP credentials
    // themselves (err.message from Nodemailer/the SMTP server doesn't
    // include SMTP_PASS - only the auth outcome).
    console.error(`Failed to send email to ${to}: ${err.message}`);
  }
}

module.exports = { sendEmail };
