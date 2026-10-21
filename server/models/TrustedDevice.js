const mongoose = require('mongoose');

const trustedDeviceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  label: { type: String, required: true, maxlength: 80 },
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', default: null, index: true },
  createdAt: { type: Date, required: true, default: Date.now },
  lastUsedAt: { type: Date, required: true, default: Date.now },
  expiresAt: { type: Date, required: true },
});

trustedDeviceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('TrustedDevice', trustedDeviceSchema);
