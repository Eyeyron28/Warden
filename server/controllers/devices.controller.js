const mongoose = require('mongoose');

const PairedDevice = require('../models/PairedDevice');

// Routes are async, but Express doesn't forward rejected promises to
// error-handling middleware on its own - this small wrapper does that so
// every handler below can just `throw` instead of repeating try/catch.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const deviceNotFound = () => httpError(404, 'Device not found.');

/**
 * GET /api/devices
 * Owner-only. Name, browser, paired / last-seen times and status - never a
 * token or hash.
 */
const listDevices = asyncHandler(async (req, res) => {
  const devices = await PairedDevice.find({ userId: req.userId }).sort({ pairedAt: -1 });
  res.status(200).json(
    devices.map((device) => ({
      id: device._id,
      deviceName: device.deviceName,
      browserLabel: device.browserLabel,
      pairedAt: device.pairedAt,
      lastSeenAt: device.lastSeenAt,
      revoked: device.revoked,
      revokedAt: device.revokedAt,
    }))
  );
});

/**
 * POST /api/devices/:id/revoke
 * Owner-only. Removes the stored token hash, so the phone's token matches
 * nothing from the next request on (401). An id that is unknown, malformed or
 * belongs to another account is a 404 - never a silent success. Revoking a
 * device of yours that is already revoked is fine (200).
 *
 * What this cannot do: the phone keeps its own encrypted local copy until it is
 * wiped or used online (the app tells the owner so).
 */
const revokeDevice = asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw deviceNotFound();
  const device = await PairedDevice.findOne({ _id: req.params.id, userId: req.userId });
  if (!device) throw deviceNotFound();

  if (!device.revoked || device.tokenHash) {
    await PairedDevice.updateOne(
      { _id: device._id, userId: req.userId },
      { $set: { revoked: true, revokedAt: device.revokedAt || new Date() }, $unset: { tokenHash: '' } }
    );
  }
  res.status(200).json({ success: true });
});

module.exports = { listDevices, revokeDevice };
