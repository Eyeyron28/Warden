const PairedDevice = require('../models/PairedDevice');
const { hashToken } = require('../utils/deviceTokens');

// Routes are async, but Express doesn't forward rejected promises to
// error-handling middleware on its own - this small wrapper does that so
// this handler can just `throw` instead of a try/catch.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// "Last seen" is written at most this often per device, so a sync of many
// requests is one write, not hundreds.
const LAST_SEEN_EVERY_MS = 60 * 1000;

function deviceRejected(message) {
  const error = new Error(message);
  error.status = 401;
  // DEVICE_REVOKED reaches the client (errorHandler allowlist) so the phone can
  // stop and say so, instead of retrying.
  error.code = 'DEVICE_REVOKED';
  return error;
}

/**
 * Guards the sync endpoints. Reads a bearer device token - issued once, at
 * pairing, by POST /api/pair/complete - and resolves it against PairedDevice
 * by its SHA-256 (the raw token is never stored). A revoked device has no
 * stored hash at all, so its token matches nothing the moment it is revoked.
 *
 * Sets req.userId from the paired device's own `userId`: a device token is
 * scoped to exactly the account it was paired under.
 *
 * A missing, malformed, unknown or revoked token is treated identically.
 */
const requireDeviceAuth = asyncHandler(async (req, res, next) => {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  const tokenHash = scheme === 'Bearer' ? hashToken(token) : null;
  if (!tokenHash) throw deviceRejected('This device is not paired, or it was removed from the account.');

  const device = await PairedDevice.findOne({ tokenHash });
  if (!device || device.revoked) throw deviceRejected('This device is not paired, or it was removed from the account.');

  const now = new Date();
  if (!device.lastSeenAt || now.getTime() - device.lastSeenAt.getTime() >= LAST_SEEN_EVERY_MS) {
    await PairedDevice.updateOne({ _id: device._id }, { $set: { lastSeenAt: now } });
  }

  req.pairedDevice = device;
  req.userId = device.userId;
  next();
});

module.exports = requireDeviceAuth;
module.exports.LAST_SEEN_EVERY_MS = LAST_SEEN_EVERY_MS;
