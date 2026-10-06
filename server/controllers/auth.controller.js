const crypto = require('crypto');

const User = require('../models/User');
const Document = require('../models/Document');
const Folder = require('../models/Folder');
const Share = require('../models/Share');
const SharedFile = require('../models/SharedFile');
const RecoveryRequestToken = require('../models/RecoveryRequestToken');
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
  verifyRecoveryKey,
} = require('../utils/crypto');
const { validatePassword } = require('../utils/passwordPolicy');
const { createSession, destroySession, destroyAllSessionsForUser } = require('../utils/sessionStore');
const { resolveLanIp } = require('../utils/network');
const { getPublicAppUrl } = require('../utils/publicAppUrl');
const { sendEmail, normalizeRecipient } = require('../utils/email');

const FAILED_ATTEMPTS_LOCKOUT_THRESHOLD = 3;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes

const EMAIL_VERIFICATION_TOKEN_BYTES = 32;
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RESET_TOKEN_BYTES = 32;
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
const RECOVERY_REQUEST_TOKEN_BYTES = 32;
const RECOVERY_REQUEST_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes, same as PairingToken

// Same text for every outcome of these two endpoints - an unknown email, an
// already-verified one, a malformed one and a real send all look identical.
const RESEND_GENERIC_MESSAGE = 'If this account exists and is not yet verified, a new link has been sent.';
const FORGOT_GENERIC_MESSAGE =
  'If this account exists and is verified, a password reset link has been sent.';

// /phone and /verify-email and /reset-password are React Router routes
// served by Vite, not this Express app - links built here have to point
// there, never at this API's own port. PUBLIC_APP_URL (set in production/
// Vercel) takes priority; resolveLanIp + this fixed dev port is the local-
// dev fallback, same pattern pairing.controller.js and shares.controller.js
// already use for their own links. Replacing the LAN-IP side of this with
// something that works once genuinely hosted (not just "PUBLIC_APP_URL is
// set") is the deferred phone-pairing/sharing redesign - this function
// itself is new, needed just to get signup/reset emails working at all.
// The origin itself now comes from utils/publicAppUrl.js (validated at
// startup, never built from request headers).
function resolvePublicAppUrl() {
  return getPublicAppUrl();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Fixed-length, constant-time string comparison for the invite code (a
// human-typed shared secret, unlike every other token in this app, which
// are all high-entropy and compared via crypto.timingSafeEqual on hashes
// already). crypto.timingSafeEqual itself requires equal-length buffers
// and throws otherwise, so lengths are equalized by hashing both sides
// first (SHA-256 output is always 32 bytes) rather than padding - hashing
// also means this never short-circuits on the raw strings' own lengths.
function constantTimeStringEqual(a, b) {
  const hashedA = crypto.createHash('sha256').update(String(a)).digest();
  const hashedB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashedA, hashedB);
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
// rejection in this app (invalidPairingToken, invalidRecoveryRequestToken):
// a token that never existed, already expired, or was already used all
// produce this exact same response.
function invalidVerificationTokenError() {
  const error = new Error('This verification link is invalid or has expired.');
  error.status = 404;
  return error;
}

function invalidResetTokenError() {
  const error = new Error('This password reset link is invalid or has expired.');
  error.status = 404;
  return error;
}

function wrongRecoveryKeyError() {
  const error = new Error('Incorrect recovery key.');
  error.status = 401;
  return error;
}

function invalidSignupError() {
  const error = new Error('Could not create an account with the information provided.');
  error.status = 403;
  return error;
}

// The recovery key's own salt isn't stored in a separate field - it's
// embedded in recoveryKeyHash as `${salt}:${hash}` (see hashRecoveryKey)
// and doubles as the salt used to derive the recovery-key KEK.
function extractRecoverySalt(recoveryKeyHash) {
  return recoveryKeyHash.split(':')[0];
}

// Deliberately generic and identical whether the token never existed,
// already expired, or was already used/not-yet-fulfilled - same
// reasoning as pairing's invalidPairingToken().
function invalidRecoveryRequestToken() {
  const error = new Error('This recovery request is invalid or has expired.');
  error.status = 404;
  return error;
}

// Thrown by the phone-recovery fingerprint check (see fingerprintDEK in
// utils/crypto.js) - deliberately worded around "this account" rather
// than exposing that a fingerprint mismatch specifically occurred.
function dekMismatchError() {
  const error = new Error('This device does not belong to this account.');
  error.status = 401;
  return error;
}

/**
 * POST /api/auth/signup
 * Body: { email, password, inviteCode? }
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
  const { email, password, inviteCode } = req.body;

  if (typeof email !== 'string' || typeof password !== 'string') {
    throw badRequest('email and password are required.');
  }
  if (inviteCode !== undefined && typeof inviteCode !== 'string') {
    throw badRequest('inviteCode must be a string.');
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

  const signupMode = (process.env.SIGNUP_MODE || 'invite').toLowerCase();
  if (signupMode === 'invite') {
    const expectedCode = process.env.INVITE_CODE || '';
    const gotCode = typeof inviteCode === 'string' ? inviteCode : '';
    if (!expectedCode || !constantTimeStringEqual(gotCode, expectedCode)) {
      throw invalidSignupError();
    }
  }

  const responseBody = {
    message: 'If this email can be registered, a verification link has been sent.',
  };

  const existingUser = await User.findOne({ email: normalizedEmail });
  if (existingUser) {
    // Nothing created, nothing changed - just an optional heads-up to the
    // real owner, in case this was them forgetting they already have an
    // account rather than someone else probing their email.
    await sendEmail({
      to: normalizedEmail,
      subject: 'Someone tried to create a Warden account with your email',
      text:
        'Someone just tried to sign up for Warden using this email address, which already has an account. ' +
        'If this was you, log in normally or use "Forgot password" instead. If it was not you, no action is ' +
        'needed - no account was created or changed.',
    });
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
  await sendEmail({
    to: normalizedEmail,
    subject: 'Verify your Warden account',
    text:
      'Welcome to Warden.\n\nVerify your email to finish setting up your account:\n' +
      `${verifyUrl || `Verification code: ${verificationToken}`}\n\n` +
      'This link expires in 24 hours. You will not be able to log in until you verify.',
  });

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
    await sendEmail({
      to: normalizedEmail,
      subject: 'Your new Warden verification link',
      text:
        'Here is a new link to verify your Warden account:\n' +
        `${verifyUrl || `Verification code: ${verificationToken}`}\n\n` +
        'This link expires in 24 hours. Any earlier verification link no longer works.',
    });
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
  const signupMode = (process.env.SIGNUP_MODE || 'invite').toLowerCase() === 'open' ? 'open' : 'invite';
  res.status(200).json({ signupMode });
};

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

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    throw lockoutError(user.lockedUntil);
  }

  const isValid = verifyPassword(password, user.salt, user.passwordHash);

  if (!isValid) {
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

  if (!user.emailVerified) {
    throw unverifiedAccountError();
  }

  // --- Hook for a future prompt: an email OTP step belongs here, between
  // "password verified" and "issue session" below. Nothing implementing
  // it exists yet. ---

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

  const sessionToken = await createSession(user._id, dek);

  res.status(200).json({ sessionToken });
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
 * POST /api/auth/forgot-password
 * Body: { email }
 * Always the same generic response - identical whether the account
 * doesn't exist, exists but isn't verified yet (an unverified account has
 * no password worth resetting - the owner should verify first), or
 * genuinely gets an email.
 */
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (typeof email !== 'string') {
    throw badRequest('email is required.');
  }
  const normalizedEmail = normalizeRecipient(email);
  if (!normalizedEmail) {
    return res.status(200).json({ message: FORGOT_GENERIC_MESSAGE });
  }

  const user = await User.findOne({ email: normalizedEmail });
  if (user && user.emailVerified) {
    const resetToken = crypto.randomBytes(RESET_TOKEN_BYTES).toString('hex');
    user.resetTokenHash = hashToken(resetToken);
    user.resetTokenExpiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    await user.save();

    const appUrl = resolvePublicAppUrl(req);
    const resetUrl = appUrl ? `${appUrl}/reset-password?token=${resetToken}` : null;
    await sendEmail({
      to: normalizedEmail,
      subject: 'Reset your Warden password',
      text:
        `Reset your password:\n${resetUrl || `Reset code: ${resetToken}`}\n\n` +
        'This link expires in 30 minutes. If you have your recovery key, enter it during reset to keep your ' +
        'existing documents. Without it, resetting will permanently delete them and start a brand-new, empty vault.',
    });
  }

  res.status(200).json({
    message: FORGOT_GENERIC_MESSAGE,
  });
});

/**
 * Shared final step of a password reset: re-wrap `dek` under a freshly-
 * derived password KEK and replace wrappedDEKPassword/passwordHash/salt,
 * clear the reset token, and clear any active lockout. If `newRecoveryKey`
 * is given, also replaces recoveryKeyHash/wrappedDEKRecovery - used only
 * by the no-recovery-key wipe path below, where the OLD recovery key
 * would otherwise keep "working" while actually unwrapping a DEK that no
 * longer corresponds to anything (see reset-password).
 *
 * Callers MUST have already verified `dek` is correct for this account
 * before calling this (or, for the wipe path, generated it fresh
 * themselves) - this function only writes.
 */
async function finalizeReset(user, dek, newPassword, { newRecoveryKey } = {}) {
  const newSalt = generateSalt();
  const newPasswordHash = hashPassword(newPassword, newSalt);
  const newPasswordKek = deriveEncryptionKey(newPassword, newSalt);
  const rewrappedPassword = wrapKey(dek, newPasswordKek);

  user.salt = newSalt;
  user.passwordHash = newPasswordHash;
  user.wrappedDEKPassword = rewrappedPassword.wrappedKey;
  user.wrappedDEKPasswordIv = rewrappedPassword.iv;
  user.wrappedDEKPasswordAuthTag = rewrappedPassword.authTag;

  if (newRecoveryKey) {
    const recoveryKeyHash = hashRecoveryKey(newRecoveryKey);
    const recoverySalt = extractRecoverySalt(recoveryKeyHash);
    const recoveryKek = deriveEncryptionKey(newRecoveryKey, recoverySalt);
    const wrappedRecovery = wrapKey(dek, recoveryKek);

    user.recoveryKeyHash = recoveryKeyHash;
    user.wrappedDEKRecovery = wrappedRecovery.wrappedKey;
    user.wrappedDEKRecoveryIv = wrappedRecovery.iv;
    user.wrappedDEKRecoveryAuthTag = wrappedRecovery.authTag;
  }

  user.dekFingerprint = fingerprintDEK(dek);
  user.failedAttempts = 0;
  user.lockedUntil = undefined;
  user.resetTokenHash = undefined;
  user.resetTokenExpiresAt = undefined;
  await user.save();
}

/**
 * POST /api/auth/reset-password
 * Body: { token, newPassword, recoveryKey?, confirmWipe? }
 *
 * token must be a live, unexpired forgot-password token - this is what
 * proves email ownership; it is never enough on its own to unwrap the DEK.
 *
 * - recoveryKey given: verify-before-write, exactly like the old
 *   POST /api/auth/recover - unwrap the DEK with it (which also proves
 *   the key itself is correct), confirm its fingerprint actually matches
 *   this account (defense in depth - should be unreachable, since
 *   wrappedDEKRecovery is this same account's own field), THEN re-wrap
 *   under the new password. Every existing document stays decryptable.
 * - recoveryKey omitted: the email link proves ownership of the inbox
 *   only, never the DEK - this path cannot preserve existing documents,
 *   so it requires confirmWipe: true, generates a brand-new DEK (and a
 *   brand-new recovery key, shown once in the response - the old one
 *   would otherwise silently stop meaning anything), and permanently
 *   deletes every document and folder marker on the account.
 *
 * Either way, every existing session for this account is destroyed
 * afterward - a stolen session token from before the reset stops working
 * immediately.
 */
const resetPassword = asyncHandler(async (req, res) => {
  const { token, newPassword, recoveryKey, confirmWipe } = req.body;

  if (!token || typeof token !== 'string') {
    throw badRequest('A reset token is required.');
  }
  if (!newPassword || typeof newPassword !== 'string') {
    throw badRequest('A new password is required.');
  }
  if (recoveryKey !== undefined && typeof recoveryKey !== 'string') {
    throw badRequest('recoveryKey must be a string.');
  }
  if (confirmWipe !== undefined && typeof confirmWipe !== 'boolean') {
    throw badRequest('confirmWipe must be a boolean.');
  }

  const { valid, errors } = validatePassword(newPassword);
  if (!valid) {
    throw passwordPolicyError(errors);
  }

  const user = await User.findOne({ resetTokenHash: hashToken(token) });
  if (!user || !user.resetTokenExpiresAt || user.resetTokenExpiresAt.getTime() <= Date.now()) {
    throw invalidResetTokenError();
  }

  let responseExtra = {};

  if (recoveryKey) {
    const isValid = verifyRecoveryKey(recoveryKey, user.recoveryKeyHash);
    if (!isValid) {
      // Nothing written - the account's password/DEK wraps are untouched.
      throw wrongRecoveryKeyError();
    }

    const recoverySalt = extractRecoverySalt(user.recoveryKeyHash);
    const recoveryKek = deriveEncryptionKey(recoveryKey, recoverySalt);
    const dek = unwrapKey(
      user.wrappedDEKRecovery,
      recoveryKek,
      user.wrappedDEKRecoveryIv,
      user.wrappedDEKRecoveryAuthTag
    );
    if (fingerprintDEK(dek) !== user.dekFingerprint) {
      throw dekMismatchError();
    }

    await finalizeReset(user, dek, newPassword);
  } else {
    if (confirmWipe !== true) {
      throw badRequest(
        'Resetting without your recovery key permanently deletes your existing documents. ' +
          'Resend with confirmWipe: true to proceed, or provide your recovery key instead to keep them.'
      );
    }

    const dek = generateDEK();
    const newRecoveryKey = generateRecoveryKey();

    await Document.deleteMany({ userId: user._id });
    await Folder.deleteMany({ userId: user._id });
    // Shares are snapshots of the old vault; a wipe should not leave copies
    // reachable by link.
    const shareIdsToDrop = (await Share.find({ ownerUserId: user._id }).select('shareId')).map((share) => share.shareId);
    await Share.deleteMany({ ownerUserId: user._id });
    await SharedFile.deleteMany({ shareId: { $in: shareIdsToDrop } });

    await finalizeReset(user, dek, newPassword, { newRecoveryKey });
    responseExtra = { recoveryKey: newRecoveryKey, documentsWiped: true };
  }

  await destroyAllSessionsForUser(user._id);

  res.status(200).json({ message: 'Password reset. Please log in.', ...responseExtra });
});

/**
 * POST /api/auth/recover-via-usb
 * TEMPORARILY DISABLED. This flow used to resolve "the" account with a
 * singleton User.findOne() - there is no longer a single account to fall
 * back to, and the USB backup manifest it reads from doesn't carry enough
 * identity (email/userId) to resolve one safely. Redesigning the backup
 * manifest format to carry that was explicitly deferred alongside the
 * rest of the USB-backup-on-Vercel work (it has the same server-local-
 * filesystem problem as backup export/import). Disabled outright rather
 * than left reachable against an arbitrary account.
 */
const recoverViaUsb = asyncHandler(async () => {
  const error = new Error(
    'USB-backup recovery is temporarily unavailable while Warden moves to multi-user accounts - it needs a ' +
      'redesign to identify which account a backup belongs to. Use "Forgot password" with your recovery key instead.'
  );
  error.status = 501;
  throw error;
});

/**
 * POST /api/auth/recover-via-phone/init
 * Body: { email }
 * No session required - the whole point is recovering access when the
 * owner can't log in normally. Unlike the old single-vault version, this
 * now has to be told WHICH account (there's no singleton to fall back to
 * anymore) - the owner types their email, same as forgot-password.
 *
 * Anti-enumeration, same spirit as every other account-lookup endpoint in
 * this app: the response is identical (and a real RecoveryRequestToken is
 * only actually created) whether or not the email has an account - an
 * unknown email just gets back a token that will correctly report itself
 * as invalid/expired everywhere else, since nothing was ever created for it.
 */
const recoverViaPhoneInit = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (typeof email !== 'string') {
    throw badRequest('email is required.');
  }
  const normalizedEmail = email.trim().toLowerCase();

  const token = crypto.randomBytes(RECOVERY_REQUEST_TOKEN_BYTES).toString('hex');
  const expiresAt = new Date(Date.now() + RECOVERY_REQUEST_TOKEN_TTL_MS);

  const user = await User.findOne({ email: normalizedEmail });
  if (user) {
    await RecoveryRequestToken.create({ userId: user._id, token, expiresAt });
  }

  // Still LAN-IP-based - meaningful only for local-network use today; see
  // the module-level comment on resolvePublicAppUrl/FRONTEND_PORT for why
  // this one specifically wasn't switched over (this QR has to be scanned
  // by a phone physically paired on the same network, the deferred part
  // of the phone-pairing redesign, not just "build any clickable link").
  const lanIp = resolveLanIp();
  const recoverUrl = lanIp
    ? `${req.protocol}://${lanIp}:${FRONTEND_PORT}/phone?recover=${token}`
    : null;

  res.status(201).json({ recoveryToken: token, recoverUrl, expiresAt });
});

/**
 * GET /api/auth/recover-via-phone/status/:token
 * Unchanged logic - a token lookup needs no account context either way.
 */
const recoverViaPhoneStatus = asyncHandler(async (req, res) => {
  const requestToken = await RecoveryRequestToken.findOne({ token: req.params.token });

  if (!requestToken) {
    return res.status(200).json({ fulfilled: false, expired: true });
  }

  const expired = requestToken.expiresAt.getTime() <= Date.now();
  res.status(200).json({ fulfilled: requestToken.fulfilled, expired });
});

/**
 * POST /api/auth/recover-via-phone/submit
 * Body: { recoveryToken, wrappedDEK, wrappedDEKIv, wrappedDEKAuthTag, wrappedDEKSalt }
 * requireDeviceAuth - req.userId is the paired phone's OWN account.
 * Rejects outright if that doesn't match the recovery request's account
 * (requestToken.userId) - a phone can only ever fulfill a recovery
 * request for the account it's actually paired with. This is defense in
 * depth: recoverViaPhoneComplete's dekFingerprint check below would catch
 * a mismatched DEK anyway, but failing here is more direct and doesn't
 * depend on that second check to stay safe.
 */
const recoverViaPhoneSubmit = asyncHandler(async (req, res) => {
  const { recoveryToken, wrappedDEK, wrappedDEKIv, wrappedDEKAuthTag, wrappedDEKSalt } = req.body;

  if (!recoveryToken || typeof recoveryToken !== 'string') {
    throw badRequest('A recovery token is required.');
  }
  for (const [field, value] of Object.entries({ wrappedDEK, wrappedDEKIv, wrappedDEKAuthTag, wrappedDEKSalt })) {
    if (!value || typeof value !== 'string') {
      throw badRequest(`"${field}" is required.`);
    }
  }

  const requestToken = await RecoveryRequestToken.findOne({ token: recoveryToken });
  if (
    !requestToken ||
    requestToken.used ||
    requestToken.fulfilled ||
    requestToken.expiresAt.getTime() <= Date.now() ||
    String(requestToken.userId) !== String(req.userId)
  ) {
    throw invalidRecoveryRequestToken();
  }

  requestToken.wrappedDEK = wrappedDEK;
  requestToken.wrappedDEKIv = wrappedDEKIv;
  requestToken.wrappedDEKAuthTag = wrappedDEKAuthTag;
  requestToken.wrappedDEKSalt = wrappedDEKSalt;
  requestToken.fulfilled = true;
  await requestToken.save();

  res.status(200).json({ success: true });
});

/**
 * POST /api/auth/recover-via-phone/complete
 * Body: { recoveryToken, newPassword }
 * No session (the locked-out PC has none). Resolves the account from
 * requestToken.userId - set at .../init from the email the owner typed in -
 * never from a singleton lookup.
 */
const recoverViaPhoneComplete = asyncHandler(async (req, res) => {
  const { recoveryToken, newPassword } = req.body;

  if (!recoveryToken || typeof recoveryToken !== 'string') {
    throw badRequest('A recovery token is required.');
  }
  if (!newPassword || typeof newPassword !== 'string') {
    throw badRequest('A new password is required.');
  }

  const { valid, errors } = validatePassword(newPassword);
  if (!valid) {
    throw passwordPolicyError(errors);
  }

  const requestToken = await RecoveryRequestToken.findOne({ token: recoveryToken });
  if (
    !requestToken ||
    requestToken.used ||
    !requestToken.fulfilled ||
    requestToken.expiresAt.getTime() <= Date.now()
  ) {
    throw invalidRecoveryRequestToken();
  }

  const user = await User.findById(requestToken.userId);
  if (!user) {
    throw invalidRecoveryRequestToken();
  }

  let dek;
  try {
    const kek = deriveEncryptionKey(recoveryToken, requestToken.wrappedDEKSalt);
    dek = unwrapKey(requestToken.wrappedDEK, kek, requestToken.wrappedDEKIv, requestToken.wrappedDEKAuthTag);
  } catch {
    throw invalidRecoveryRequestToken();
  }

  if (fingerprintDEK(dek) !== user.dekFingerprint) {
    throw dekMismatchError();
  }

  await finalizeReset(user, dek, newPassword);
  await destroyAllSessionsForUser(user._id);

  requestToken.used = true;
  await requestToken.save();

  const sessionToken = await createSession(user._id, dek);
  res.status(200).json({ sessionToken });
});

/**
 * POST /api/auth/logout
 * Protected by requireSession. Explicitly deletes the session's document
 * rather than letting it merely expire - this is what makes "Log out" a
 * real security boundary instead of just a UI state change.
 */
const logout = asyncHandler(async (req, res) => {
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
  forgotPassword,
  resetPassword,
  recoverViaUsb,
  recoverViaPhoneInit,
  recoverViaPhoneStatus,
  recoverViaPhoneSubmit,
  recoverViaPhoneComplete,
  logout,
};
