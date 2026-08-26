const PairedDevice = require('../models/PairedDevice');

// Routes are async, but Express doesn't forward rejected promises to
// error-handling middleware on its own - this small wrapper does that so
// this handler can just `throw` instead of a try/catch.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Guards the sync endpoints (POST /api/sync/pull, /push). Reads a bearer
 * deviceToken - issued once, at pairing time, by POST /api/pair/complete -
 * and resolves it against PairedDevice, same shape as requireSession but
 * a different credential and a different store: a device token is
 * long-lived (until the owner revokes it) rather than an in-memory
 * session, since the phone has no equivalent of "unlocking" the PC's
 * vault each time it wants to sync.
 *
 * A missing/unknown/revoked token is treated identically - all three mean
 * "this device cannot sync" - so this never leaks which case applies.
 */
const requireDeviceAuth = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    const error = new Error('Missing or invalid Authorization header.');
    error.status = 401;
    throw error;
  }

  const device = await PairedDevice.findOne({ deviceToken: token });
  if (!device || device.revoked) {
    const error = new Error('This device is not paired, or its access was revoked.');
    error.status = 401;
    throw error;
  }

  req.pairedDevice = device;
  next();
});

module.exports = requireDeviceAuth;
