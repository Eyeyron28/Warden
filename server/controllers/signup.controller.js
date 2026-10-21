const User = require('../models/User');
const { normalizeRecipient, sendEmail } = require('../utils/email');
const { templates } = require('../utils/emailTemplates');
const { validatePassword } = require('../utils/passwordPolicy');
const { domainCanReceiveMail } = require('../utils/emailDomain');
const { otpTtlMinutes } = require('../utils/otpConfig');
const { consumeBudget } = require('../middleware/rateLimit');
const { bulkMailOpen } = require('../utils/mailBudget');
const { PRIVACY_POLICY_VERSION } = require('../utils/policyVersion');
const { recordDuration, padLikeReal } = require('../utils/sendTiming');
const { buildAccountFields, isDuplicateKey } = require('../utils/accountCreate');
const {
  subjectKeyFor,
  MAX_RESENDS,
  RESEND_GAP_MS,
  issueSignupCode,
  resendSignupCode,
  hasPendingSignup,
  checkSignupCode,
  consumeSignupCode,
} = require('../utils/signupCodes');
const { issueLoginSession } = require('./auth.controller');

const START_MESSAGE = 'If this address can be used, we sent a 6-digit code to it.';
const VERIFY_FAILED = 'That code didn’t work. Check it or ask for a new one.';
const NO_MAIL_DOMAIN = 'That email domain can’t receive mail. Check for a typo.';
const SIGNUP_BUSY = 'Sign-up is busy right now. Please try again later.';

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status }, extra);
}
const badRequest = (message) => httpError(400, message);
const verifyFailed = () => httpError(401, VERIFY_FAILED);

function passwordPolicyError(errors) {
  return httpError(400, 'Password does not meet the security requirements.', { errors });
}

function neutralAnswer() {
  const now = Date.now();
  return {
    message: START_MESSAGE,
    otpRequired: true,
    codeLength: 6,
    expiresAt: new Date(now + otpTtlMinutes() * 60 * 1000),
    resendAvailableAt: new Date(now + RESEND_GAP_MS),
    resendsLeft: MAX_RESENDS,
  };
}

const spendAddressBudget = (email) =>
  consumeBudget({ name: 'signup-code-address', key: subjectKeyFor(email), max: 5, windowMs: 60 * 60 * 1000 });
const tooMany = () => httpError(429, 'Too many codes have been requested for this address. Please try again later.');

const signupStart = asyncHandler(async (req, res) => {
  const { email, password, termsAccepted } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') throw badRequest('email and password are required.');

  const address = normalizeRecipient(email);
  if (!address) throw badRequest('A valid email is required.');

  const { valid, errors } = validatePassword(password);
  if (!valid) throw passwordPolicyError(errors);
  if (termsAccepted !== true) throw badRequest('Please agree to the Terms of use and the Privacy policy to continue.');

  if (!(await domainCanReceiveMail(address))) throw httpError(400, NO_MAIL_DOMAIN, { code: 'EMAIL_DOMAIN_NO_MAIL' });

  if (!(await bulkMailOpen())) throw httpError(503, SIGNUP_BUSY, { expose: true });

  if (!(await spendAddressBudget(address))) throw tooMany();

  const startedAt = Date.now();
  const existing = await User.findOne({ email: address });
  if (existing) {
    await sendEmail({ to: address, ...templates.signupAttempt({ when: new Date() }) });
    await padLikeReal('signup-start', startedAt);
    res.status(200).json(neutralAnswer());
    return;
  }

  await issueSignupCode(address, { acceptedAt: new Date(), policyVersion: PRIVACY_POLICY_VERSION });
  recordDuration('signup-start', Date.now() - startedAt);
  res.status(200).json(neutralAnswer());
});

const signupVerify = asyncHandler(async (req, res) => {
  const { email, password, code } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string' || typeof code !== 'string') throw verifyFailed();
  const address = normalizeRecipient(email);
  if (!address) throw verifyFailed();

  const { valid, errors } = validatePassword(password);
  if (!valid) throw passwordPolicyError(errors);

  const checked = await checkSignupCode(address, code);
  if (!checked.ok) throw verifyFailed();
  if (!checked.consent?.acceptedAt || !checked.consent?.policyVersion) throw verifyFailed();
  if (!(await consumeSignupCode(checked.id))) throw verifyFailed();

  const { fields, recoveryKey, dek } = buildAccountFields(password);
  let user;
  try {
    if (await User.findOne({ email: address })) throw verifyFailed();
    user = await User.create({ email: address, emailVerified: true, consent: { acceptedAt: checked.consent.acceptedAt, policyVersion: checked.consent.policyVersion }, ...fields });
  } catch (error) {
    if (isDuplicateKey(error)) throw verifyFailed();
    throw error;
  }

  const sessionToken = await issueLoginSession(req, res, user, dek, { trust: false });

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ sessionToken, recoveryKey });
});

const signupResend = asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  const address = typeof email === 'string' ? normalizeRecipient(email) : null;
  const startedAt = Date.now();
  let sent = false;
  if (address && (await hasPendingSignup(address)) && !(await User.findOne({ email: address }))) {
    if (await spendAddressBudget(address)) {
      const result = await resendSignupCode(address);
      sent = Boolean(result.sent);
    }
  }
  if (sent) recordDuration('signup-start', Date.now() - startedAt);
  else await padLikeReal('signup-start', startedAt);
  res.status(200).json(neutralAnswer());
});

const goneSignup = (req, res) => {
  res.status(410).json({
    success: false,
    error: { message: 'Sign-up now starts with a code sent to your email. Please reload the page and try again.' },
  });
};

module.exports = { signupStart, signupVerify, signupResend, goneSignup, START_MESSAGE, VERIFY_FAILED, NO_MAIL_DOMAIN, SIGNUP_BUSY };
