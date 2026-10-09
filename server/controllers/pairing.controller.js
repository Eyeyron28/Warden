const crypto = require('crypto');

const PairingToken = require('../models/PairingToken');
const PairedDevice = require('../models/PairedDevice');
const User = require('../models/User');
const { verifyPassword, deriveEncryptionKey, unwrapKey } = require('../utils/crypto');
const { newToken, hashToken } = require('../utils/deviceTokens');
const { PURPOSES, startChallenge, consumeChallenge, resendChallenge } = require('../utils/otpChallenge');
const { labelFromUserAgent } = require('../utils/trustedDevice');
const { getPublicAppUrl, publicAppUrlIsConfigured } = require('../utils/publicAppUrl');
const { sendEmail } = require('../utils/email');
const { consumeBudget, isBudgetExhausted } = require('../middleware/rateLimit');

// Routes are async, but Express doesn't forward rejected promises to
// error-handling middleware on its own - this small wrapper does that so
// every handler below can just `throw` instead of repeating try/catch.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_TOKEN_FAILURES = 5; // wrong passwords against one QR, then it is dead
const ACCOUNT_FAILURES_PER_HOUR = 10; // wrong passwords against one account's QRs
const ACCOUNT_WINDOW_MS = 60 * 60 * 1000;
const MAX_DEVICE_NAME = 60;

// The ONE answer for every way completing a pairing can fail: no such QR,
// expired, already used, killed by too many tries, wrong master password. A
// caller learns nothing about which of those it was.
const PAIR_FAILED = 'Pairing failed. Check your master password, or generate a new code on your computer and scan it again.';
const pairFailed = () => httpError(401, PAIR_FAILED);

// Same work for a dead QR as for a live one, so timing doesn't say which it was.
const DUMMY_SALT = 'a'.repeat(32);
const DUMMY_HASH = 'b'.repeat(128);
const burnPasswordCheck = (password) => {
  try {
    verifyPassword(password, DUMMY_SALT, DUMMY_HASH);
  } catch {
    // only the time spent matters
  }
};

async function currentUser(req) {
  const user = await User.findById(req.userId);
  if (!user) throw httpError(401, 'Session expired or invalid. Please log in again.');
  return user;
}

/**
 * POST /api/pair/code
 * requireSession. Emails the owner a one-time code for pairing a device. A
 * stolen session alone cannot pair a phone: the code goes to the account's
 * mailbox. The challenge is for this purpose only (it cannot log in or delete
 * an account) and never involves the vault key.
 */
const requestPairCode = asyncHandler(async (req, res) => {
  const user = await currentUser(req);
  res.status(200).json(await startChallenge({ user, secret: crypto.randomBytes(32), purpose: PURPOSES.pairDevice }));
});

/** POST /api/pair/resend-code - requireSession. Body: { challengeToken } */
const resendPairCode = asyncHandler(async (req, res) => {
  res.status(200).json(
    await resendChallenge({
      challengeToken: req.body.challengeToken,
      purpose: PURPOSES.pairDevice,
      userId: req.userId,
      findUser: (id) => User.findById(id),
    })
  );
});

/**
 * POST /api/pair/init
 * requireSession. Body: { challengeToken, code }
 * With the right emailed code (single use, 5 guesses), creates a 5-minute,
 * single-use pairing token and returns the raw value ONCE; only its hash is
 * stored. `appUrl` is the validated PUBLIC_APP_URL when one is configured;
 * otherwise the browser uses its own origin (development).
 */
const initPairing = asyncHandler(async (req, res) => {
  const { challengeToken, code } = req.body;
  if (typeof challengeToken !== 'string' || typeof code !== 'string') {
    throw httpError(400, 'The code from your email is required.');
  }
  await consumeChallenge({ challengeToken, code, purpose: PURPOSES.pairDevice, userId: req.userId });

  const token = newToken();
  const expiresAt = new Date(Date.now() + PAIRING_TOKEN_TTL_MS);
  await PairingToken.create({ userId: req.userId, tokenHash: hashToken(token), expiresAt, used: false, failedAttempts: 0 });

  res.status(201).json({
    pairingToken: token,
    expiresAt,
    appUrl: publicAppUrlIsConfigured() ? getPublicAppUrl() : null,
  });
});

/**
 * GET /api/pair/status/:token
 * Owner-only - polled while the QR is on screen. A token that never existed,
 * belongs to someone else, or is already gone is `expired: true`.
 */
const getPairingStatus = asyncHandler(async (req, res) => {
  const tokenHash = hashToken(req.params.token);
  const pairingToken = tokenHash ? await PairingToken.findOne({ tokenHash, userId: req.userId }) : null;
  if (!pairingToken) {
    return res.status(200).json({ used: false, expired: true });
  }
  const expired = pairingToken.expiresAt.getTime() <= Date.now();
  res.status(200).json({ used: pairingToken.used, expired });
});

/**
 * POST /api/pair/complete
 * Body: { pairingToken, masterPassword, deviceName }
 * Deliberately NOT behind requireSession - the phone has no session yet. The
 * pairingToken (unguessable, 5 minutes, single use) proves the owner's screen
 * showed it; the master password proves the person holding the phone knows it.
 *
 * Wrong passwords are counted against the token (the 5th deletes it), against
 * the account (10 an hour, whichever QR), and against the connection (the
 * route's own limiter). Every failure is the same generic 401.
 *
 * The response carries, once, the device token for the sync API (only its hash
 * is kept) and the vault key, so the phone can wrap it under its own PIN. The
 * PIN never reaches the server and the server keeps no copy of that wrap.
 */
const completePairing = asyncHandler(async (req, res) => {
  const { pairingToken, masterPassword, deviceName } = req.body;

  if (typeof pairingToken !== 'string' || typeof masterPassword !== 'string' || !pairingToken || !masterPassword) {
    throw httpError(400, 'A pairing code and your master password are required.');
  }
  if (deviceName !== undefined && typeof deviceName !== 'string') {
    throw httpError(400, 'The device name must be text.');
  }

  const tokenHash = hashToken(pairingToken);
  const token = tokenHash ? await PairingToken.findOne({ tokenHash }) : null;
  if (!token || token.used || token.expiresAt.getTime() <= Date.now() || token.failedAttempts >= MAX_TOKEN_FAILURES) {
    burnPasswordCheck(masterPassword);
    throw pairFailed();
  }

  const accountBudget = { name: 'pair-complete-account', key: String(token.userId), max: ACCOUNT_FAILURES_PER_HOUR };
  if (await isBudgetExhausted(accountBudget)) {
    burnPasswordCheck(masterPassword);
    throw httpError(429, 'Too many failed attempts. Please try again later.');
  }

  const user = await User.findById(token.userId);
  if (!user) {
    burnPasswordCheck(masterPassword);
    throw pairFailed();
  }

  if (!verifyPassword(masterPassword, user.salt, user.passwordHash)) {
    await consumeBudget({ ...accountBudget, windowMs: ACCOUNT_WINDOW_MS });
    const counted = await PairingToken.findOneAndUpdate({ _id: token._id }, { $inc: { failedAttempts: 1 } }, { new: true });
    if (counted && counted.failedAttempts >= MAX_TOKEN_FAILURES) await PairingToken.deleteOne({ _id: token._id });
    throw pairFailed();
  }

  const dek = unwrapKey(
    user.wrappedDEKPassword,
    deriveEncryptionKey(masterPassword, user.salt),
    user.wrappedDEKPasswordIv,
    user.wrappedDEKPasswordAuthTag
  );

  // Single use: only one request can claim the token.
  const claimed = await PairingToken.findOneAndUpdate(
    { _id: token._id, used: false, failedAttempts: { $lt: MAX_TOKEN_FAILURES } },
    { $set: { used: true } },
    { new: true }
  );
  if (!claimed) throw pairFailed();

  const deviceToken = newToken();
  const name = typeof deviceName === 'string' ? deviceName.trim().slice(0, MAX_DEVICE_NAME) : '';
  const browserLabel = labelFromUserAgent(req.headers['user-agent']);
  const device = await PairedDevice.create({
    userId: user._id,
    deviceName: name || undefined,
    browserLabel,
    tokenHash: hashToken(deviceToken),
    lastSeenAt: null,
    revoked: false,
  });

  // Best effort, and never allowed to undo the pairing. No codes or tokens in it.
  const when = new Date().toUTCString();
  sendEmail({
    to: user.email,
    subject: 'A new device was paired with your Warden account',
    text:
      `A new device was paired with your Warden account.\n\n` +
      `Name: ${name || 'Unnamed device'}\nBrowser: ${browserLabel}\nTime: ${when}\n\n` +
      `If this was you, nothing more to do. If it was not, open Devices in Warden and remove it, ` +
      `then change your password.`,
  }).catch(() => false);

  res.status(201).json({
    deviceId: device._id,
    deviceToken,
    // Raw vault key, once, over TLS (same trust as a signed-in web session).
    dek: Buffer.from(dek).toString('base64'),
  });
});

module.exports = { requestPairCode, resendPairCode, initPairing, getPairingStatus, completePairing, PAIR_FAILED };
