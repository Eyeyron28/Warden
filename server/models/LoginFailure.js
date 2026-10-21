const mongoose = require('mongoose');

const loginFailureSchema = new mongoose.Schema({
  key: { type: String, required: true },
  count: { type: Number, default: 0 },
  windowExpiresAt: { type: Date, default: null },
  lockedUntil: { type: Date, default: null },
  granted: { type: Boolean, default: true },
  expireAt: { type: Date, required: true },
});

loginFailureSchema.index({ key: 1 }, { unique: true });
loginFailureSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('LoginFailure', loginFailureSchema);
