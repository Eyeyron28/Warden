const crypto = require('crypto');

const User = require('../models/User');
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
const { createSession, destroySession } = require('../utils/sessionStore');
const { resolveLanIp } = require('../utils/network');

const FAILED_ATTEMPTS_LOCKOUT_THRESHOLD = 3;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes

const RECOVERY_REQUEST_TOKEN_BYTES = 32;
const RECOVERY_REQUEST_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes, same as PairingToken
const MIN_USB_PASSPHRASE_LENGTH = 4; // same floor as the phone pairing PIN
// Same reasoning as shares.controller.js's FRONTEND_PORT: /phone is a
// React Router route served by Vite, not this Express app, so the QR
// below has to point there, never at this API's own port.
const FRONTEND_PORT = 5173;

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

// Deliberately generic and identical whether the token never existed,
// already expired, or was already used/not-yet-fulfilled - same
// reasoning as pairing's invalidPairingToken(): a caller here has no
// business learning which case applies.
function invalidRecoveryRequestToken() {
  const error = new Error('This recovery request is invalid or has expired.');
  error.status = 404;
  return error;
}

function wrongUsbPassphraseError() {
  const error = new Error('Incorrect USB passphrase, or this backup is corrupted.');
  error.status = 401;
  return error;
}

// Thrown by both new recovery flows' fingerprint check (see fingerprintDEK
// in utils/crypto.js) - deliberately worded around "this vault" rather
// than exposing that a fingerprint mismatch specifically occurred, so it
// reads the same to a caller as any other "that didn't work" rejection.
function dekMismatchError() {
  const error = new Error('This backup or device does not belong to this vault.');
  error.status = 401;
  return error;
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
    dekFingerprint: fingerprintDEK(dek),
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

  const sessionToken = await finalizeRecovery(user, dek, newPassword);

  res.status(200).json({ sessionToken });
});

/**
 * Shared final step of every "forgot password" flow (recovery key, USB,
 * paired phone): re-wrap an already-VERIFIED dek under a freshly-derived
 * password KEK and replace wrappedDEKPassword/passwordHash/salt. Because
 * the DEK itself never changes, every document encrypted before the reset
 * stays decryptable after it - only the password changes, not the
 * vault's actual encryption key. Also clears any active lockout, same as
 * a successful ordinary unlock would.
 *
 * Callers MUST have already verified `dek` is correct/trustworthy (the
 * recovery key against recoveryKeyHash, a USB passphrase/token against
 * fingerprintDEK, etc.) before calling this - this function itself does
 * no verification, it only writes.
 *
 * @param {import('mongoose').Document} user
 * @param {Buffer} dek - already-verified, correct for this vault
 * @param {string} newPassword - already policy-validated by the caller
 * @returns {Promise<string>} sessionToken
 */
async function finalizeRecovery(user, dek, newPassword) {
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

  return createSession(dek);
}

/**
 * POST /api/auth/recover-via-usb
 * Body: { wrappedDEK, wrappedDEKIv, wrappedDEKAuthTag, wrappedDEKSalt,
 *         usbPassphrase, newPassword }
 * The frontend reads these wrapped fields itself, client-side, out of the
 * selected backup folder's backup-manifest.json (see POST
 * /api/backup/export, which is what writes them there in the first
 * place) - this endpoint never touches the filesystem, it only verifies
 * key material the caller already extracted and submits.
 *
 * Same verify-before-write discipline as POST /api/auth/recover: unwrap
 * first (which also proves the passphrase was correct - unwrapKey throws
 * on a wrong KEK or tampered data), THEN confirm the result is actually
 * this vault's DEK via fingerprintDEK (see that function's comment for
 * why a correct-for-its-own-blob passphrase isn't enough on its own -
 * the blob itself could be from an unrelated Warden installation's USB
 * backup), and only then write anything.
 */
const recoverViaUsb = asyncHandler(async (req, res) => {
  const { wrappedDEK, wrappedDEKIv, wrappedDEKAuthTag, wrappedDEKSalt, usbPassphrase, newPassword } =
    req.body;

  for (const [field, value] of Object.entries({
    wrappedDEK,
    wrappedDEKIv,
    wrappedDEKAuthTag,
    wrappedDEKSalt,
  })) {
    if (!value || typeof value !== 'string') {
      throw badRequest(
        `This backup folder's manifest is missing "${field}" - it may predate USB recovery support, or not be a Warden backup at all.`
      );
    }
  }
  if (!usbPassphrase || typeof usbPassphrase !== 'string') {
    throw badRequest('The USB recovery passphrase is required.');
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

  let dek;
  try {
    const usbKek = deriveEncryptionKey(usbPassphrase, wrappedDEKSalt);
    dek = unwrapKey(wrappedDEK, usbKek, wrappedDEKIv, wrappedDEKAuthTag);
  } catch {
    throw wrongUsbPassphraseError();
  }

  if (fingerprintDEK(dek) !== user.dekFingerprint) {
    throw dekMismatchError();
  }

  const sessionToken = await finalizeRecovery(user, dek, newPassword);

  res.status(200).json({ sessionToken });
});

/**
 * POST /api/auth/recover-via-phone/init
 * No auth required - same trust model as POST /api/auth/recover: the
 * whole point is recovering access when the owner CAN'T unlock normally,
 * so there's no session to require. Generates a short-lived, single-use
 * token (same shape/TTL as PairingToken).
 *
 * The token itself is a 64-character hex string - far too long to
 * usefully hand-type on a phone, so recoverUrl encodes it into a
 * directly-openable `/phone?recover=<token>` URL, same "QR the owner's
 * phone camera opens straight into the right screen" pattern as
 * PairDevicePanel's pairing QR (see that component's own comment for why
 * this can't be window.location.origin: the owner's own tab on the PC is
 * very often "localhost", meaningless to a phone). Built from
 * resolveLanIp (utils/network.js, shared with pairing/sharing) rather
 * than required - if it can't be determined, recoverUrl comes back null
 * and the frontend falls back to the raw token as a manually-typed code,
 * degrading gracefully instead of failing the whole request.
 */
const recoverViaPhoneInit = asyncHandler(async (req, res) => {
  const token = crypto.randomBytes(RECOVERY_REQUEST_TOKEN_BYTES).toString('hex');
  const expiresAt = new Date(Date.now() + RECOVERY_REQUEST_TOKEN_TTL_MS);

  await RecoveryRequestToken.create({ token, expiresAt });

  const lanIp = resolveLanIp();
  const recoverUrl = lanIp
    ? `${req.protocol}://${lanIp}:${FRONTEND_PORT}/phone?recover=${token}`
    : null;

  res.status(201).json({ recoveryToken: token, recoverUrl, expiresAt });
});

/**
 * GET /api/auth/recover-via-phone/status/:token
 * Polled by the locked-out PC while its code is on screen, same pattern
 * as GET /api/pair/status/:token. Deliberately never returns the wrapped
 * DEK material itself (even once fulfilled) - only whether it's ready -
 * so that material never has to round-trip through the PC's poll loop at
 * all; POST .../complete reads it straight from this same DB record.
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
 * The paired phone's side, once its owner has PIN-unlocked it and typed
 * in the code shown on the locked-out PC. Authenticated with the phone's
 * existing deviceToken (requireDeviceAuth, see routes/auth.routes.js) -
 * only a device already paired with THIS vault can respond at all,
 * before the fingerprint check below even runs.
 *
 * The phone wraps its live, already-unwrapped DEK under a key derived
 * from `recoveryToken` itself (known to both sides only because the
 * owner physically copied it from one screen to the other) rather than
 * sending the raw DEK - see services/localCrypto.js wrapDEK on the
 * client. This handler just stores that wrapped material on the token
 * record for the PC to pick up via .../complete; it doesn't unwrap or
 * verify it yet; there's no new-password context here to finish the job.
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
    requestToken.expiresAt.getTime() <= Date.now()
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
 * No auth required, for the same reason POST /api/auth/recover isn't:
 * the PC calling this has no session. The recoveryToken IS the
 * credential (same trust model as GET /api/shared/:token and POST
 * /api/pair/complete) - whoever holds a still-valid, fulfilled,
 * not-yet-used token is trusted to complete the recovery with it, since
 * producing that exact token in the first place required reading it off
 * this same PC's own screen a moment earlier.
 *
 * Re-derives the SAME KEK the phone derived in .../submit (from
 * recoveryToken + the salt the phone generated and sent then, now
 * stored on this token record) to unwrap the DEK the phone wrapped -
 * verify-before-write via the same two checks as recoverViaUsb: the
 * unwrap itself (proves the token/salt pairing is intact and untampered)
 * and the fingerprint match (proves it's actually this vault's DEK, not
 * some other vault's paired phone answering a token for a different
 * installation).
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

  const user = await User.findOne();
  if (!user) {
    const error = new Error('The vault has not been set up yet.');
    error.status = 404;
    throw error;
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

  const sessionToken = await finalizeRecovery(user, dek, newPassword);

  requestToken.used = true;
  await requestToken.save();

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
  recoverViaUsb,
  recoverViaPhoneInit,
  recoverViaPhoneStatus,
  recoverViaPhoneSubmit,
  recoverViaPhoneComplete,
  logout,
};
