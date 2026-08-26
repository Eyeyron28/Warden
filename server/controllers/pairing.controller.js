const crypto = require('crypto');

const PairingToken = require('../models/PairingToken');
const PairedDevice = require('../models/PairedDevice');
const User = require('../models/User');
const { verifyPassword, deriveEncryptionKey, unwrapKey, generateSalt, wrapKey } = require('../utils/crypto');

// Routes are async, but Express doesn't forward rejected promises to
// error-handling middleware on its own - this small wrapper does that so
// every handler below can just `throw` instead of repeating try/catch.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

// Deliberately generic and identical whether the token never existed,
// already expired, or was already used - same reasoning as the public
// share-view endpoint's rejection. A 404, distinct from the 401 a wrong
// master password gets below, is what lets the frontend tell "this QR is
// dead, go rescan" apart from "retype the password" without this message
// itself giving anything away.
function invalidPairingToken() {
  const error = new Error('This pairing code is invalid or has expired.');
  error.status = 404;
  return error;
}

const PAIRING_TOKEN_BYTES = 32;
const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MIN_PHONE_PIN_LENGTH = 4;

/**
 * Determines the PC's LAN-reachable address for the phone to call
 * directly (not through the React dev server - the phone talks to this
 * API, wherever it lives). There's no reliable way for a Node process to
 * know its own LAN IP from inside a request handler alone: a machine can
 * have several network interfaces (Wi-Fi, Ethernet, VPN, a Docker
 * bridge...) and guessing which one a phone on the same network can
 * actually reach is exactly that - a guess.
 *
 * LAN_IP is the explicit, correct answer (see .env.example) and always
 * wins if set. Absent that, req.socket.localAddress is a best-effort
 * fallback - it only produces something useful if the owner's own
 * browser happened to reach this API via its LAN IP already, since a
 * request to localhost/127.0.0.1 makes the socket's local address
 * equally useless to a phone.
 */
function resolveApiBase(req) {
  const port = process.env.PORT || 5000;

  if (process.env.LAN_IP) {
    return `http://${process.env.LAN_IP}:${port}`;
  }

  const socketAddress = req.socket.localAddress?.replace('::ffff:', '');
  if (socketAddress && socketAddress !== '127.0.0.1' && socketAddress !== '::1') {
    return `http://${socketAddress}:${port}`;
  }

  return null;
}

/**
 * POST /api/pair/init
 * Owner-only (requireSession). Generates a short-lived pairing token and
 * the PC's LAN-reachable API address, both of which the frontend encodes
 * into a QR code for the phone to scan. Only builds the PC's half of
 * pairing - nothing here verifies a phone or creates a PairedDevice; that
 * happens when the phone-side scan-and-verify flow (a separate pass)
 * calls back in with this token.
 */
const initPairing = asyncHandler(async (req, res) => {
  const apiBase = resolveApiBase(req);
  if (!apiBase) {
    const error = new Error(
      "Could not determine this PC's LAN address. Set the LAN_IP environment variable (see .env.example) and restart the server."
    );
    error.status = 500;
    throw error;
  }

  const token = crypto.randomBytes(PAIRING_TOKEN_BYTES).toString('hex');
  const expiresAt = new Date(Date.now() + PAIRING_TOKEN_TTL_MS);

  await PairingToken.create({ token, expiresAt });

  res.status(201).json({ pairingToken: token, apiBase, expiresAt });
});

/**
 * GET /api/pair/status/:token
 * Owner-only - polled while the QR is on screen so it can move from
 * "Waiting for phone..." to "Paired successfully" (or "expired") without
 * a manual refresh. A token that never existed is folded into the same
 * `expired: true` bucket as one that's genuinely timed out - there's
 * nothing else useful to distinguish for this owner-only endpoint, and
 * it keeps the frontend's state machine to just two signals: used, or
 * not usable anymore.
 */
const getPairingStatus = asyncHandler(async (req, res) => {
  const pairingToken = await PairingToken.findOne({ token: req.params.token });

  if (!pairingToken) {
    return res.status(200).json({ used: false, expired: true });
  }

  const expired = pairingToken.expiresAt.getTime() <= Date.now();

  res.status(200).json({ used: pairingToken.used, expired });
});

/**
 * POST /api/pair/complete
 * Body: { pairingToken, masterPassword, phonePin, deviceName }
 * Deliberately NOT behind requireSession - the phone has no session yet.
 * The pairingToken IS the credential proving this request is legitimate,
 * same trust model as GET /api/shared/:token: whoever holds a still-
 * valid, unused pairing token is trusted to attempt completing pairing
 * with it.
 *
 * A wrong master password does NOT consume the token - only a
 * successful completion marks it used - so the phone can retry a
 * mistyped password without forcing the owner to generate and re-scan a
 * brand new QR, as long as the token itself hasn't expired.
 */
const completePairing = asyncHandler(async (req, res) => {
  const { pairingToken, masterPassword, phonePin, deviceName } = req.body;

  if (!pairingToken || typeof pairingToken !== 'string') {
    throw badRequest('A pairing token is required.');
  }
  if (!masterPassword || typeof masterPassword !== 'string') {
    throw badRequest('A master password is required.');
  }
  if (!phonePin || typeof phonePin !== 'string' || phonePin.length < MIN_PHONE_PIN_LENGTH) {
    throw badRequest(`Device PIN must be at least ${MIN_PHONE_PIN_LENGTH} characters.`);
  }

  const token = await PairingToken.findOne({ token: pairingToken });
  if (!token || token.used || token.expiresAt.getTime() <= Date.now()) {
    throw invalidPairingToken();
  }

  const user = await User.findOne();
  if (!user) {
    // No vault to pair against - same generic response as a dead token,
    // rather than a distinguishable "vault not set up" that leaks state
    // to an unauthenticated caller.
    throw invalidPairingToken();
  }

  const isValid = verifyPassword(masterPassword, user.salt, user.passwordHash);
  if (!isValid) {
    const error = new Error('Incorrect master password.');
    error.status = 401;
    throw error;
  }

  const passwordKek = deriveEncryptionKey(masterPassword, user.salt);
  const dek = unwrapKey(
    user.wrappedDEKPassword,
    passwordKek,
    user.wrappedDEKPasswordIv,
    user.wrappedDEKPasswordAuthTag
  );

  // Same wrap-the-DEK pattern as every other KEK in this app: a COPY of
  // the DEK, wrapped under a key derived from the phone's own PIN, so
  // the phone can unwrap it later using only something it holds itself -
  // the master password is never sent again after this one request.
  const pinSalt = generateSalt();
  const pinKek = deriveEncryptionKey(phonePin, pinSalt);
  const wrappedPin = wrapKey(dek, pinKek);

  const device = await PairedDevice.create({
    deviceName: typeof deviceName === 'string' && deviceName.trim() ? deviceName.trim() : undefined,
    wrappedDEKPhonePin: wrappedPin.wrappedKey,
    wrappedDEKPhonePinIv: wrappedPin.iv,
    wrappedDEKPhonePinAuthTag: wrappedPin.authTag,
    wrappedDEKPhonePinSalt: pinSalt,
  });

  token.used = true;
  await token.save();

  res.status(201).json({
    deviceId: device._id,
    wrappedDEKPhonePin: device.wrappedDEKPhonePin,
    wrappedDEKPhonePinIv: device.wrappedDEKPhonePinIv,
    wrappedDEKPhonePinAuthTag: device.wrappedDEKPhonePinAuthTag,
    wrappedDEKPhonePinSalt: device.wrappedDEKPhonePinSalt,
  });
});

module.exports = { initPairing, getPairingStatus, completePairing };
