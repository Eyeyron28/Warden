const crypto = require('crypto');

const PairingToken = require('../models/PairingToken');

// Routes are async, but Express doesn't forward rejected promises to
// error-handling middleware on its own - this small wrapper does that so
// every handler below can just `throw` instead of repeating try/catch.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const PAIRING_TOKEN_BYTES = 32;
const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

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

module.exports = { initPairing, getPairingStatus };
