const User = require('../models/User');
const {
  generateSalt,
  hashPassword,
  verifyPassword,
  deriveEncryptionKey,
  generateDEK,
  wrapKey,
  unwrapKey,
  generateRecoveryKey,
  hashRecoveryKey,
  verifyRecoveryKey,
} = require('../utils/crypto');
const { validatePassword } = require('../utils/passwordPolicy');
const { createSession, destroySession } = require('../utils/sessionStore');

const FAILED_ATTEMPTS_LOCKOUT_THRESHOLD = 3;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes

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

// Rejects the request outright with the vault's lockout state - used both
// when a lockout is already active and the moment one is newly triggered,
// so a locked-out caller always gets this shape rather than a plain 401.
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

// The recovery key's own salt isn't stored in a separate field - it's
// embedded in recoveryKeyHash as `${salt}:${hash}` (see hashRecoveryKey)
// and doubles as the salt used to derive the recovery-key KEK.
function extractRecoverySalt(recoveryKeyHash) {
  return recoveryKeyHash.split(':')[0];
}

/**
 * GET /api/auth/status
 * Tells the frontend whether the vault has been set up yet, so it knows
 * whether to show the "create password" screen or the "enter password"
 * screen.
 */
const getStatus = asyncHandler(async (req, res) => {
  const userExists = await User.exists({});
  res.status(200).json({ initialized: Boolean(userExists) });
});

/**
 * POST /api/auth/setup
 * Body: { password }
 * First-run only: creates the single User record, generates the one-time
 * recovery key, and immediately opens a session so the caller lands
 * straight in the vault without a second unlock step.
 *
 * Generates the vault's DEK once and wraps it under both a
 * password-derived key and a recovery-key-derived key, so either secret
 * alone is enough to recover it later (see models/User.js).
 */
const setup = asyncHandler(async (req, res) => {
  const { password } = req.body;

  if (!password || typeof password !== 'string') {
    throw badRequest('A password is required.');
  }

  const existingUser = await User.exists({});
  if (existingUser) {
    const error = new Error('The vault has already been set up.');
    error.status = 409;
    throw error;
  }

  const { valid, errors } = validatePassword(password);
  if (!valid) {
    throw passwordPolicyError(errors);
  }

  const salt = generateSalt();
  const passwordHash = hashPassword(password, salt);

  // Shown to the caller exactly once in this response and never stored or
  // returned in plaintext again - only its hash is persisted below.
  const recoveryKey = generateRecoveryKey();
  const recoveryKeyHash = hashRecoveryKey(recoveryKey);
  const recoverySalt = extractRecoverySalt(recoveryKeyHash);

  const dek = generateDEK();

  const passwordKek = deriveEncryptionKey(password, salt);
  const wrappedPassword = wrapKey(dek, passwordKek);

  const recoveryKek = deriveEncryptionKey(recoveryKey, recoverySalt);
  const wrappedRecovery = wrapKey(dek, recoveryKek);

  await User.create({
    passwordHash,
    salt,
    recoveryKeyHash,
    wrappedDEKPassword: wrappedPassword.wrappedKey,
    wrappedDEKPasswordIv: wrappedPassword.iv,
    wrappedDEKPasswordAuthTag: wrappedPassword.authTag,
    wrappedDEKRecovery: wrappedRecovery.wrappedKey,
    wrappedDEKRecoveryIv: wrappedRecovery.iv,
    wrappedDEKRecoveryAuthTag: wrappedRecovery.authTag,
  });

  const sessionToken = createSession(dek);

  res.status(201).json({ sessionToken, recoveryKey });
});

/**
 * POST /api/auth/unlock
 * Body: { password }
 * Verifies the master password against the stored hash and, on success,
 * unwraps the DEK and opens a session with it.
 *
 * Lockout, not just throttling: 3 consecutive failed attempts sets
 * lockedUntil 5 minutes out, and while that's in the future, unlock is
 * rejected before password verification even runs - a correct password
 * doesn't bypass an active lockout. Crossing the threshold also resets
 * failedAttempts to 0, so the count after the lockout expires starts
 * fresh rather than being pre-loaded toward an instant re-lock.
 */
const unlock = asyncHandler(async (req, res) => {
  const { password } = req.body;

  if (!password || typeof password !== 'string') {
    throw badRequest('A password is required.');
  }

  const user = await User.findOne();
  if (!user) {
    const error = new Error('The vault has not been set up yet.');
    error.status = 404;
    throw error;
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

    const error = new Error('Incorrect password.');
    error.status = 401;
    throw error;
  }

  user.failedAttempts = 0;
  user.lockedUntil = undefined;
  await user.save();

  const passwordKek = deriveEncryptionKey(password, user.salt);
  const dek = unwrapKey(
    user.wrappedDEKPassword,
    passwordKek,
    user.wrappedDEKPasswordIv,
    user.wrappedDEKPasswordAuthTag
  );

  const sessionToken = createSession(dek);

  res.status(200).json({ sessionToken });
});

/**
 * POST /api/auth/recover
 * Body: { recoveryKey, newPassword }
 * The "forgot password" flow. Verifies the recovery key, unwraps the DEK
 * using the recovery-key-derived KEK (the password is never involved),
 * then re-wraps that SAME DEK under a newly-derived password KEK and
 * replaces wrappedDEKPassword/passwordHash/salt. Because the DEK itself
 * never changes, every document encrypted before the reset stays
 * decryptable after it - only the password changes, not the vault's
 * actual encryption key.
 *
 * Known limitation: the recovery key itself is not rotated here - using
 * it to reset the password doesn't invalidate it, so the same recovery
 * key keeps working afterward. Real rotation (generating a new recovery
 * key, re-wrapping the DEK under it, and updating recoveryKeyHash) is
 * meaningful added complexity - re-showing a new one-time key, updating
 * the UI's "save this key" flow again - that's out of scope for this
 * pass.
 */
const recover = asyncHandler(async (req, res) => {
  const { recoveryKey, newPassword } = req.body;

  if (!recoveryKey || typeof recoveryKey !== 'string') {
    throw badRequest('A recovery key is required.');
  }
  if (!newPassword || typeof newPassword !== 'string') {
    throw badRequest('A new password is required.');
  }

  const { valid, errors } = validatePassword(newPassword);
  if (!valid) {
    throw passwordPolicyError(errors);
  }

  const user = await User.findOne();
  if (!user) {
    const error = new Error('The vault has not been set up yet.');
    error.status = 404;
    throw error;
  }

  const isValid = verifyRecoveryKey(recoveryKey, user.recoveryKeyHash);
  if (!isValid) {
    const error = new Error('Incorrect recovery key.');
    error.status = 401;
    throw error;
  }

  const recoverySalt = extractRecoverySalt(user.recoveryKeyHash);
  const recoveryKek = deriveEncryptionKey(recoveryKey, recoverySalt);
  const dek = unwrapKey(
    user.wrappedDEKRecovery,
    recoveryKek,
    user.wrappedDEKRecoveryIv,
    user.wrappedDEKRecoveryAuthTag
  );

  const newSalt = generateSalt();
  const newPasswordHash = hashPassword(newPassword, newSalt);
  const newPasswordKek = deriveEncryptionKey(newPassword, newSalt);
  const rewrapped = wrapKey(dek, newPasswordKek);

  user.salt = newSalt;
  user.passwordHash = newPasswordHash;
  user.wrappedDEKPassword = rewrapped.wrappedKey;
  user.wrappedDEKPasswordIv = rewrapped.iv;
  user.wrappedDEKPasswordAuthTag = rewrapped.authTag;
  user.failedAttempts = 0;
  user.lockedUntil = undefined;
  await user.save();

  const sessionToken = createSession(dek);

  res.status(200).json({ sessionToken });
});

/**
 * POST /api/auth/logout
 * Protected by requireSession. Explicitly deletes the session's entry from
 * the in-memory store rather than letting it merely expire - this is what
 * makes "Lock vault" a real security boundary instead of just a UI state
 * change: the moment this responds, the old token is dead everywhere, not
 * just forgotten on this client.
 */
const logout = asyncHandler(async (req, res) => {
  destroySession(req.session.token);
  res.status(200).json({ success: true });
});

module.exports = {
  getStatus,
  setup,
  unlock,
  recover,
  logout,
};
