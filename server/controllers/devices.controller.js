const mongoose = require('mongoose');

const PairedDevice = require('../models/PairedDevice');

// Routes are async, but Express doesn't forward rejected promises to
// error-handling middleware on its own - this small wrapper does that so
// every handler below can just `throw` instead of repeating try/catch.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function assertValidId(id, label = 'device') {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw badRequest(`Invalid ${label} id.`);
  }
}

/**
 * GET /api/devices
 * Owner-only. Metadata only - deviceName, pairedAt, revoked - never
 * wrappedDEKPhonePin or its iv/authTag/salt, and never deviceToken: the
 * owner's UI only ever needs to decide whether to revoke a device, not
 * to hold its key material or sync credential.
 */
const listDevices = asyncHandler(async (req, res) => {
  const devices = await PairedDevice.find().sort({ pairedAt: -1 });
  res.status(200).json(
    devices.map((device) => ({
      id: device._id,
      deviceName: device.deviceName,
      pairedAt: device.pairedAt,
      revoked: device.revoked,
    }))
  );
});

/**
 * POST /api/devices/:id/revoke
 * Idempotent, same reasoning as revokeShare/revokeShareById in
 * shares.controller.js: the caller wants an end state ("this device can
 * no longer sync"), not a transition, so an already-revoked or unknown
 * id both just return success rather than needing to be distinguished.
 *
 * This is the actual security boundary: requireDeviceAuth (middleware/
 * requireDeviceAuth.js) checks this same `revoked` flag on every
 * POST /api/sync/pull and /push, so a revoked device's still-valid-
 * looking deviceToken (sitting in its own IndexedDB from pairing) stops
 * working the moment this flips.
 */
const revokeDevice = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);
  await PairedDevice.updateOne({ _id: req.params.id }, { $set: { revoked: true } });
  res.status(200).json({ success: true });
});

module.exports = { listDevices, revokeDevice };
