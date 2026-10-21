const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  deviceIdHash: { type: String, required: true },
  label: { type: String, required: true, maxlength: 80 },
  firstSeenAt: { type: Date, required: true, default: Date.now },
  lastSeenAt: { type: Date, required: true, default: Date.now },
  lastCountry: { type: String, default: null },
  lastCity: { type: String, default: null },
  trusted: { type: Boolean, default: false },
  signedOutAt: { type: Date, default: null },
});

deviceSchema.index({ userId: 1, deviceIdHash: 1 }, { unique: true });

module.exports = mongoose.model('Device', deviceSchema);
