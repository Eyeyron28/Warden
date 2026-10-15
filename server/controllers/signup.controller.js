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

/**
 * Sign-up in two steps, and NO account until the address is proven:
 *
 *   POST /api/auth/signup/start   {email, password, termsAccepted, inviteCode?}
 *       checks the form, that the domain can receive mail, and the invite code (route middleware, first); then mails a 6-digit
 *       code. Creates no user, no vault key and no recovery key, and stores no password - only a pending code.
 *   POST /api/auth/signup/verify  {email, password, code}
 *       only with the right code: creates the account (the same key work as ever), signs the person in through
 *       issueLoginSession (the one place a login session is made) and returns the recovery key, once.
 *   POST /api/auth/signup/resend  {email}
 *
 * Anti-enumeration: start and resend answer the same for an address that already has an account (which gets a notice
 * email and NO code) as for a new one, with the same work and about the same time.
 */

const START_MESSAGE = 'If this address can be used, we sent a 6-digit code to it.';
const VERIFY_FAILED = 'That code didn’t work. Check it or ask for a new one.';
const NO_MAIL_DOMAIN = 'That email domain can’t receive mail. Check for a typo.';
// The one answer when today's bulk mail budget is used up (utils/mailBudget.js): the same for every address.
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

/** The one answer start and resend give, whatever the address. */
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

// Five code emails an hour per address, however it got here (start or resend), counted for every address alike.
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

  // Depends only on the typed domain, so it reveals nothing about any account.
  if (!(await domainCanReceiveMail(address))) throw httpError(400, NO_MAIL_DOMAIN, { code: 'EMAIL_DOMAIN_NO_MAIL' });

  // Today's sign-up mail budget is spent: refuse BEFORE looking anything up about the address, so the answer is the same
  // for an address with an account and one without (no enumeration), and keep what is left for login codes.
  if (!(await bulkMailOpen())) throw httpError(503, SIGNUP_BUSY, { expose: true });

  if (!(await spendAddressBudget(address))) throw tooMany();

  const startedAt = Date.now();
  const existing = await User.findOne({ email: address });
  if (existing) {
    // The real owner gets a heads-up and NO code. About as long as a real start takes, and the same answer.
    await sendEmail({ to: address, ...templates.signupAttempt({ when: new Date() }) });
    await padLikeReal('signup-start', startedAt);
    res.status(200).json(neutralAnswer());
    return;
  }

  // A failed send is not reported (the existing-address path hides its own); the person can ask for the code again.
  // What was agreed to travels with the pending code and is written to the account only if the code is entered.
  await issueSignupCode(address, { acceptedAt: new Date(), policyVersion: PRIVACY_POLICY_VERSION });
  recordDuration('signup-start', Date.now() - startedAt);
  res.status(200).json(neutralAnswer());
});

const signupVerify = asyncHandler(async (req, res) => {
  const { email, password, code } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string' || typeof code !== 'string') throw verifyFailed();
  const address = normalizeRecipient(email);
  if (!address) throw verifyFailed();

  // A form mistake, not a guess: refused before the code is counted.
  const { valid, errors } = validatePassword(password);
  if (!valid) throw passwordPolicyError(errors);

  // Counted first, atomically; one generic failure for wrong, expired, used, out of tries, or no pending code at all.
  const checked = await checkSignupCode(address, code);
  if (!checked.ok) throw verifyFailed();
  // A pending code without a consent record (one started before consent was recorded) cannot make an account: start again.
  if (!checked.consent?.acceptedAt || !checked.consent?.policyVersion) throw verifyFailed();
  if (!(await consumeSignupCode(checked.id))) throw verifyFailed();

  // Only now does anything exist: the user, the vault key and the recovery key.
  const { fields, recoveryKey, dek } = buildAccountFields(password);
  let user;
  try {
    if (await User.findOne({ email: address })) throw verifyFailed();
    user = await User.create({ email: address, emailVerified: true, consent: { acceptedAt: checked.consent.acceptedAt, policyVersion: checked.consent.policyVersion }, ...fields });
  } catch (error) {
    // Two verifies for the same address at once, or an account made in the meantime: the loser gets the generic failure.
    if (isDuplicateKey(error)) throw verifyFailed();
    throw error;
  }

  // They just proved the inbox, so no second code; and the browser is NOT trusted by default.
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
    // Only a pending address with no account reaches here; the gap and the caps are decided by one conditional update.
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
