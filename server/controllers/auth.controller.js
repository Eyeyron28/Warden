const User = require('../models/User');
const {
  generateSalt,
  hashPassword,
  verifyPassword,
  deriveEncryptionKey,
  generateRecoveryKey,
  hashRecoveryKey,
} = require('../utils/crypto');
const { createSession } = require('../utils/sessionStore');

const FAILED_ATTEMPTS_THROTTLE_THRESHOLD = 5;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Routes are async, but Express doesn't forward rejected promises to
// error-handling middleware on its own - this small wrapper does that so
// every handler below can just `throw` instead of repeating try/catch.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
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

  const salt = generateSalt();
  const passwordHash = hashPassword(password, salt);

  // Shown to the caller exactly once in this response and never stored or
  // returned in plaintext again - only its hash is persisted below.
  const recoveryKey = generateRecoveryKey();
  const recoveryKeyHash = hashRecoveryKey(recoveryKey);

  await User.create({ passwordHash, salt, recoveryKeyHash });

  const encryptionKey = deriveEncryptionKey(password, salt);
  const sessionToken = createSession(encryptionKey);

  res.status(201).json({ sessionToken, recoveryKey });
});

/**
 * POST /api/auth/unlock
 * Body: { password }
 * Verifies the master password against the stored hash and, on success,
 * opens a session. Failed attempts are counted on the User record; once
 * they cross the throttle threshold, a short artificial delay is added
 * before responding as basic brute-force friction.
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

  const isValid = verifyPassword(password, user.salt, user.passwordHash);

  if (!isValid) {
    user.failedAttempts += 1;
    await user.save();

    if (user.failedAttempts >= FAILED_ATTEMPTS_THROTTLE_THRESHOLD) {
      await delay(1000 + Math.random() * 1000);
    }

    const error = new Error('Incorrect password.');
    error.status = 401;
    throw error;
  }

  user.failedAttempts = 0;
  await user.save();

  const encryptionKey = deriveEncryptionKey(password, user.salt);
  const sessionToken = createSession(encryptionKey);

  res.status(200).json({ sessionToken });
});

module.exports = {
  getStatus,
  setup,
  unlock,
};
