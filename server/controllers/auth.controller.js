const crypto = require('crypto');

const User = require('../models/User');
const {
  generateSalt,
  hashPassword,
  verifyPassword,
  deriveEncryptionKey,
  generateDEK,
  fingerprintDEK,
  wrapKey,
  unwrapKey,
  generateRecoveryKey,
  hashRecoveryKey,
} = require('../utils/crypto');
const { validatePassword } = require('../utils/passwordPolicy');
const { assertInviteCode, signupMode, requestAccessText } = require('../utils/inviteGate');
const { trustThisBrowser, isTrustedFor, labelFromUserAgent, parseUserAgent } = require('../utils/trustedDevice');
const { resolveDevice, deviceFromCookie } = require('../utils/deviceIdentity');
const { recordEvent, countryFrom, cityFrom } = require('../utils/audit');
const { templates } = require('../utils/emailTemplates');
const { createSession, destroySession, destroyAllSessionsForUser } = require('../utils/sessionStore');
const { getPublicAppUrl } = require('../utils/publicAppUrl');
const { sendEmail, normalizeRecipient } = require('../utils/email');
const { otpEnabled } = require('../utils/otpConfig');
const { PURPOSES, startChallenge, consumeChallenge, resendChallenge } = require('../utils/otpChallenge');
const { finalizeReset, extractRecoverySalt } = require('../utils/accountReset');

const FAILED_ATTEMPTS_LOCKOUT_THRESHOLD = 3;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes

const EMAIL_VERIFICATION_TOKEN_BYTES = 32;
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Same text for every outcome of these two endpoints - an unknown email, an
// already-verified one, a malformed one and a real send all look identical.
const RESEND_GENERIC_MESSAGE = 'If this account exists and is not yet verified, a new link has been sent.';

// /phone and /verify-email are React Router routes served by the web app, not
// this Express app - links built here have to point there. The origin comes
// from utils/publicAppUrl.js (validated at startup, never built from request
// headers).
function resolvePublicAppUrl() {
  return getPublicAppUrl();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Fixed dummy salt/hash, computed once at module load (not per-request) -
// used by login to run the exact same scrypt cost against an unknown
// email as a real one, so the response time alone can't reveal whether an
// account exists. The "password" and salt here are arbitrary; nothing
// ever needs to match against this hash, only to spend the same CPU time
// computing one.
const DUMMY_SALT = generateSalt();
const DUMMY_HASH = hashPassword('warden-timing-parity-dummy-password', DUMMY_SALT);

// Routes are async, but Express doesn't forward rejected promises to
// error-handling middleware on its own - this small wrapper does that so
// every handler below can just `throw` instead of repeating try/catch.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function passwordPolicyError(errors) {
  const error = new Error('Password does not meet the security requirements.');
  error.status = 400;
  error.errors = errors;
  return error;
}

// Rejects the request outright with the account's lockout state - used
// both when a lockout is already active and the moment one is newly
// triggered, so a locked-out caller always gets this shape rather than a
// plain 401.
function lockoutError(lockedUntil) {
  const minutesRemaining = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 60000));
  const error = new Error(
    `Too many failed attempts. Try again in ${minutesRemaining} minute${minutesRemaining === 1 ? '' : 's'}.`
  );
  error.status = 403;
  error.locked = true;
  error.lockedUntil = lockedUntil.toISOString();
  error.minutesRemaining = minutesRemaining;
  return error;
}

// Deliberately identical for an unknown email and a wrong password - see
// login below.
function genericLoginError() {
  const error = new Error('Incorrect email or password.');
  error.status = 401;
  return error;
}

function unverifiedAccountError() {
  const error = new Error('Please verify your email before logging in. Check your inbox for the link.');
  error.status = 403;
  error.emailVerificationRequired = true;
  return error;
}

// Deliberately generic, same reasoning as every other short-lived-token
// rejection in this app:
// a token that never existed, already expired, or was already used all
// produce this exact same response.
function invalidVerificationTokenError() {
  const error = new Error('This verification link is invalid or has expired.');
  error.status = 404;
  return error;
}

/**
 * POST /api/auth/signup
 * Body: { email, password, inviteCode } (inviteCode only matters unless SIGNUP_MODE is "open")
 *
 * Creates the account using the exact same vault-creation logic the old
 * single-vault setup used (generate the DEK, wrap it under the password
 * and the recovery key, store dekFingerprint) - just per-account instead
 * of global. The account cannot log in until its email is verified (see
 * login below).
 *
 * Anti-enumeration: the response is BYTE-IDENTICAL whether or not the
 * email already has an account - including a `recoveryKey` field of the
 * same shape either way. For a genuinely new account that's the real,
 * one-time recovery key (generateRecoveryKey() output wrapped to the
 * DEK). For an email that already has an account, it's a second,
 * unrelated generateRecoveryKey() call whose output is never used or
 * stored anywhere - its only purpose is making the two responses
 * indistinguishable by shape, not just by message text. This is why the
 * recovery key is generated AFTER the existing-account check rather than
 * shown only on success: showing it solely on a real signup would itself
 * be the enumeration oracle (recoveryKey present = new account).
 */
const signup = asyncHandler(async (req, res) => {
  // First of all, before the email is looked at (see utils/inviteGate.js). The
  // route already ran it as middleware; this covers a direct call.
  if (!req.inviteChecked) await assertInviteCode(req);

  const { email, password } = req.body;

  if (typeof email !== 'string' || typeof password !== 'string') {
    throw badRequest('email and password are required.');
  }

  // Must be exactly one plain address (see utils/email.js isSafeRecipient):
  // an address like "a,b@evil.com" would otherwise create an account and have
  // its verification link mailed to BOTH recipients. Checked first, before
  // anything is looked up, created or generated. The answer depends only on
  // the text typed, never on whether an account exists, so it reveals nothing
  // about who is registered.
  const normalizedEmail = normalizeRecipient(email);
  if (!normalizedEmail) {
    throw badRequest('A valid email is required.');
  }

  const { valid, errors } = validatePassword(password);
  if (!valid) {
    throw passwordPolicyError(errors);
  }

  const responseBody = {
    message: 'If this email can be registered, a verification link has been sent.',
  };

  const existingUser = await User.findOne({ email: normalizedEmail });
  if (existingUser) {
    // Nothing created, nothing changed - just an optional heads-up to the
    // real owner, in case this was them forgetting they already have an
    // account rather than someone else probing their email.
    await sendEmail({ to: normalizedEmail, ...templates.signupAttempt({ when: new Date() }) });
    // Decoy recovery key - see function comment above for why this exists.
    res.status(200).json({ ...responseBody, recoveryKey: generateRecoveryKey() });
    return;
  }

  const salt = generateSalt();
  const passwordHash = hashPassword(password, salt);

  const recoveryKey = generateRecoveryKey();
  const recoveryKeyHash = hashRecoveryKey(recoveryKey);
  const recoverySalt = extractRecoverySalt(recoveryKeyHash);

  const dek = generateDEK();

  const passwordKek = deriveEncryptionKey(password, salt);
  const wrappedPassword = wrapKey(dek, passwordKek);

  const recoveryKek = deriveEncryptionKey(recoveryKey, recoverySalt);
  const wrappedRecovery = wrapKey(dek, recoveryKek);

  const verificationToken = crypto.randomBytes(EMAIL_VERIFICATION_TOKEN_BYTES).toString('hex');

  await User.create({
    email: normalizedEmail,
    emailVerified: false,
    verificationTokenHash: hashToken(verificationToken),
    verificationTokenExpiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
    passwordHash,
    salt,
    recoveryKeyHash,
    wrappedDEKPassword: wrappedPassword.wrappedKey,
    wrappedDEKPasswordIv: wrappedPassword.iv,
    wrappedDEKPasswordAuthTag: wrappedPassword.authTag,
    wrappedDEKRecovery: wrappedRecovery.wrappedKey,
    wrappedDEKRecoveryIv: wrappedRecovery.iv,
    wrappedDEKRecoveryAuthTag: wrappedRecovery.authTag,
    dekFingerprint: fingerprintDEK(dek),
  });

  const appUrl = resolvePublicAppUrl(req);
  const verifyUrl = appUrl ? `${appUrl}/verify-email?token=${verificationToken}` : null;
  await sendEmail({ to: normalizedEmail, ...templates.verifyEmail({ verifyUrl }) });

  res.status(200).json({ ...responseBody, recoveryKey });
});

/**
 * POST /api/auth/verify-email
 * Body: { token }
 * Single-use: clears the token fields the moment it's consumed, so a
 * second request with the same token finds no matching user and gets the
 * same generic "invalid or expired" response as a token that never
 * existed.
 */
const verifyEmail = asyncHandler(async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    throw badRequest('A verification token is required.');
  }

  const user = await User.findOne({ verificationTokenHash: hashToken(token) });
  if (!user || !user.verificationTokenExpiresAt || user.verificationTokenExpiresAt.getTime() <= Date.now()) {
    throw invalidVerificationTokenError();
  }

  user.emailVerified = true;
  user.verificationTokenHash = undefined;
  user.verificationTokenExpiresAt = undefined;
  await user.save();

  res.status(200).json({ message: 'Email verified. You can now log in.' });
});

/**
 * POST /api/auth/resend-verification
 * Body: { email }
 * Always the same generic response, whether the email is unknown, already
 * verified, or genuinely gets a new link - same anti-enumeration rule as
 * signup and forgot-password. Only an existing, unverified account gets a
 * fresh token, which REPLACES the stored hash, so the previous link stops
 * working the moment this one is issued. Rate-limited per IP and per email
 * (one send per email per 60 seconds) in routes/auth.routes.js.
 */
const resendVerification = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (typeof email !== 'string' || !email.trim()) {
    throw badRequest('email is required.');
  }
  // Not a single plain address: nothing to look up, no token, no email - and
  // the very same generic answer as every other outcome.
  const normalizedEmail = normalizeRecipient(email);
  if (!normalizedEmail) {
    return res.status(200).json({ message: RESEND_GENERIC_MESSAGE });
  }

  const user = await User.findOne({ email: normalizedEmail });
  if (user && !user.emailVerified) {
    const verificationToken = crypto.randomBytes(EMAIL_VERIFICATION_TOKEN_BYTES).toString('hex');
    user.verificationTokenHash = hashToken(verificationToken);
    user.verificationTokenExpiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);
    await user.save();

    const appUrl = resolvePublicAppUrl(req);
    const verifyUrl = appUrl ? `${appUrl}/verify-email?token=${verificationToken}` : null;
    await sendEmail({ to: normalizedEmail, ...templates.verifyEmailResend({ verifyUrl }) });
  }

  res.status(200).json({
    message: RESEND_GENERIC_MESSAGE,
  });
});

/**
 * GET /api/auth/config
 * Public, non-sensitive settings the signup screen needs before the
 * person has an account - currently only whether an invite code is
 * required. Never exposes the code itself.
 */
const getPublicConfig = (req, res) => {
  const mode = signupMode();
  const body = { signupMode: mode };
  // A plain-text line on how to ask for a code (REQUEST_ACCESS_TEXT). Only
  // sent in invite mode; the page renders it as text, never as HTML.
  if (mode === 'invite') {
    const text = requestAccessText();
    if (text) body.requestAccessText = text;
  }
  res.status(200).json(body);
};

/**
 * Verifies a password for a known account with the lockout rules every
 * password check shares: while locked, the check does not even run; 3
 * consecutive failures lock the account for 5 minutes. Used by login and by
 * the re-check before an account deletion code is sent, so a stolen session
 * cannot be used to guess the password any faster than a login can.
 */
async function checkPasswordWithLockout(user, password) {
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    throw lockoutError(user.lockedUntil);
  }

  if (!verifyPassword(password, user.salt, user.passwordHash)) {
    user.failedAttempts += 1;

    if (user.failedAttempts >= FAILED_ATTEMPTS_LOCKOUT_THRESHOLD) {
      user.lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
      user.failedAttempts = 0;
      await user.save();
      throw lockoutError(user.lockedUntil);
    }

    await user.save();
    throw genericLoginError();
  }
}

/**
 * Ends a successful login: finds (or creates) this browser's Device, creates the session linked to it,
 * remembers the browser when the owner ticked "Trust this browser", writes the `login` event, and - the
 * first time an account is signed in from a browser it has not seen before (and it has seen others) - emails
 * the owner. Every place that hands out a session goes through here.
 */
async function issueLoginSession(req, res, user, dek, { trust = false } = {}) {
  const { device, isNew, hadOtherDevices } = await resolveDevice(req, res, user._id);
  const sessionToken = await createSession(user._id, dek, { deviceId: device._id });

  if (trust) {
    await trustThisBrowser(req, res, user._id, { deviceId: device._id });
    await recordEvent(req, 'trusted_added', { userId: user._id, deviceId: device._id });
    // Best effort: a heads-up that a browser now skips the emailed code.
    sendEmail({
      to: user.email,
      ...templates.trustedBrowser({ browser: labelFromUserAgent(req.headers['user-agent']), when: new Date() }),
    }).catch(() => false);
  }

  await recordEvent(req, 'login', { userId: user._id, deviceId: device._id });

  if (isNew && hadOtherDevices) {
    const { browser, os } = parseUserAgent(req.headers['user-agent']);
    sendEmail({
      to: user.email,
      ...templates.newDevice({ browser, os, country: countryFrom(req), city: cityFrom(req), when: new Date() }),
    }).catch(() => false);
  }
  return sessionToken;
}

/**
 * The ONE place a password login goes on: it either answers with a code challenge (the default, always in
 * production) or, only on a development server with OTP_ENABLED=false, a session. No route can hand out a
 * session without the emailed code. (The other places that create a session are the trusted-browser skip in
 * unlock, after the password, and verifyOtp, after the code - both through issueLoginSession.)
 */
async function respondWithLoginChallenge(req, res, user, dek) {
  if (otpEnabled()) {
    const challenge = await startChallenge({ user, secret: dek, purpose: PURPOSES.login });
    await recordEvent(req, 'otp_sent', { userId: user._id, deviceId: (await deviceFromCookie(req, user._id))?._id || null });
    res.status(200).json(challenge);
    return;
  }
  res.status(200).json({ sessionToken: await issueLoginSession(req, res, user, dek) });
}

/**
 * POST /api/auth/unlock
 * Body: { email, password }
 * Login. Route path kept as "unlock" to avoid an unrelated client churn,
 * but it's a real multi-account login now, by email.
 *
 * Lockout, same as before: 3 consecutive failed attempts sets lockedUntil
 * 5 minutes out, tracked per account (User.failedAttempts/lockedUntil),
 * and while that's in the future, login is rejected before password
 * verification even runs.
 *
 * Unknown email and wrong password are byte-identical (status, body, and
 * - via the dummy-salt scrypt call below - response time). Only once the
 * password has been verified correct does an unverified account get its
 * own distinct message; a wrong password against an unverified account
 * still gets the same generic error as any other wrong password, so
 * email-verification state is never revealed to a caller who hasn't
 * already proven they know the password.
 */
const unlock = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (typeof email !== 'string' || typeof password !== 'string') {
    throw badRequest('email and password are required.');
  }
  const normalizedEmail = email.trim().toLowerCase();

  const user = await User.findOne({ email: normalizedEmail });

  if (!user) {
    // Same scrypt cost as a real verifyPassword call below, against a
    // fixed dummy salt/hash - the result is discarded, only the timing
    // matters.
    verifyPassword(password, DUMMY_SALT, DUMMY_HASH);
    throw genericLoginError();
  }

  try {
    await checkPasswordWithLockout(user, password);
  } catch (failure) {
    // A wrong password (or a locked account): one `login_failed` event, then the same error as before.
    await recordEvent(req, 'login_failed', { userId: user._id, deviceId: (await deviceFromCookie(req, user._id))?._id || null });
    throw failure;
  }

  if (!user.emailVerified) {
    throw unverifiedAccountError();
  }

  const passwordKek = deriveEncryptionKey(password, user.salt);
  const dek = unwrapKey(
    user.wrappedDEKPassword,
    passwordKek,
    user.wrappedDEKPasswordIv,
    user.wrappedDEKPasswordAuthTag
  );

  user.failedAttempts = 0;
  user.lockedUntil = undefined;
  await user.save();

  // A browser the owner trusted after an earlier code skips the code - but
  // only here, AFTER the password has been proven. Phone recovery, deletion
  // and share-email codes never consult it. Anything wrong with the cookie
  // just means the normal flow below, indistinguishably.
  if (otpEnabled() && (await isTrustedFor(req, user._id, res))) {
    res.status(200).json({ sessionToken: await issueLoginSession(req, res, user, dek) });
    return;
  }

  // Second factor: the password alone no longer gets a session. A 6-digit
  // code is emailed and the vault key is parked WRAPPED under a random key
  // that only the browser receives (utils/otpChallenge.js).
  await respondWithLoginChallenge(req, res, user, dek);
});

/**
 * POST /api/auth/verify-otp
 * Body: { challengeToken, code }
 * Completes a login: checks the emailed code and only then issues the
 * session. See utils/otpChallenge.js: at most 5 guesses, single use, one
 * generic error for every failure - and only a challenge made for a LOGIN
 * can be used here (a delete-account code finds nothing).
 */
const verifyOtp = asyncHandler(async (req, res) => {
  const { challengeToken, code } = req.body;
  const { claimed, secret: dek } = await consumeChallenge({
    challengeToken,
    code,
    purpose: PURPOSES.login,
  });

  const user = await User.findById(claimed.userId);
  if (!user || !user.emailVerified) {
    const error = new Error('That code is incorrect or has expired.');
    error.status = 401;
    throw error;
  }

  // The owner ticked "Trust this browser": only now, after a correct code.
  const sessionToken = await issueLoginSession(req, res, user, dek, { trust: req.body.trustDevice === true });
  res.status(200).json({ sessionToken });
});

/**
 * POST /api/auth/resend-otp
 * Body: { challengeToken }
 * A new login code for the same challenge (previous one stops working).
 */
const resendOtp = asyncHandler(async (req, res) => {
  res.status(200).json(
    await resendChallenge({
      challengeToken: req.body.challengeToken,
      purpose: PURPOSES.login,
      findUser: (id) => User.findById(id),
    })
  );
});

/**
 * GET /api/auth/me
 * requireSession. Replaces the old singleton GET /api/auth/status
 * ("has THE vault been set up") - there is no single vault anymore, so
 * the only "status" worth asking is "who, if anyone, is this bearer
 * token logged in as," which only makes sense behind requireSession.
 */
const getMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) {
    const error = new Error('Account not found.');
    error.status = 404;
    throw error;
  }
  res.status(200).json({ email: user.email, emailVerified: user.emailVerified });
});

/**
 * POST /api/auth/logout
 * Protected by requireSession. Explicitly deletes the session's document
 * rather than letting it merely expire - this is what makes "Log out" a
 * real security boundary instead of just a UI state change.
 */
const logout = asyncHandler(async (req, res) => {
  await recordEvent(req, 'logout');
  await destroySession(req.session.token);
  res.status(200).json({ success: true });
});

module.exports = {
  signup,
  verifyEmail,
  resendVerification,
  getPublicConfig,
  unlock,
  getMe,
  verifyOtp,
  resendOtp,
  logout,
  checkPasswordWithLockout,
};
