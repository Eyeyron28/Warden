const crypto = require('crypto');

const { sendEmail, isSafeRecipient } = require('../utils/email');
const { templates } = require('../utils/emailTemplates');
const { consumeBudget } = require('../middleware/rateLimit');

const CONTACT_RECIPIENT = 'warden.vault.app@gmail.com';
const NAME_MAX = 100;
const MESSAGE_MAX = 2000;
const EMAIL_MAX = 254;
const CONTACT_MAX = 3;
const CONTACT_WINDOW_MS = 60 * 60 * 1000;

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const singleLine = (value) => value.replace(/[\r\n\u2028\u2029]+/g, ' ').trim();

const sendContactMessage = asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  if (typeof body.website === 'string' && body.website !== '') {
    res.status(200).json({ success: true });
    return;
  }

  if (typeof body.name !== 'string' || typeof body.email !== 'string' || typeof body.message !== 'string') {
    throw httpError(400, 'Please fill in your name, your email and a message.');
  }

  const name = singleLine(body.name);
  const email = singleLine(body.email);
  const message = body.message.replace(/\r\n?/g, '\n').trim();

  if (name.length < 1 || name.length > NAME_MAX) throw httpError(400, `Please enter your name (up to ${NAME_MAX} characters).`);
  if (email.length > EMAIL_MAX || !isSafeRecipient(email)) throw httpError(400, 'That email address doesn’t look right.');
  if (message.length < 1 || message.length > MESSAGE_MAX) throw httpError(400, `Please write a message of up to ${MESSAGE_MAX} characters.`);

  const allowed = await consumeBudget({
    name: 'contact-email',
    key: crypto.createHash('sha256').update(email.toLowerCase()).digest('hex'),
    max: CONTACT_MAX,
    windowMs: CONTACT_WINDOW_MS,
  });
  if (!allowed) throw httpError(429, 'Too many messages from this email address. Please try again later.');

  let sent = false;
  try {
    sent = await sendEmail({ to: CONTACT_RECIPIENT, replyTo: email, logBody: false, ...templates.contactMessage({ name, email, message }) });
  } catch {
    sent = false;
  }
  if (!sent) throw httpError(502, 'The message could not be sent.');

  res.status(200).json({ success: true });
});

module.exports = { sendContactMessage, CONTACT_RECIPIENT, CONTACT_MAX, CONTACT_WINDOW_MS };
