const mongoose = require('mongoose');

// One browser that has signed in to one account. Identified by a long random id kept in a strictly
// functional cookie (`warden_did`); only its SHA-256 is stored. `label` is a coarse "Browser on OS"
// from the User-Agent (no fingerprinting) and the place is country and city ONLY, taken from the
// hosting platform's headers - never an IP address, never a third-party lookup.
const deviceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  deviceIdHash: { type: String, required: true },
  label: { type: String, required: true, maxlength: 80 },
  firstSeenAt: { type: Date, required: true, default: Date.now },
  lastSeenAt: { type: Date, required: true, default: Date.now },
  lastCountry: { type: String, default: null },
  lastCity: { type: String, default: null },
  trusted: { type: Boolean, default: false },
  // Set when the owner signed this device out; cleared by its next sign-in (which is then flagged).
  signedOutAt: { type: Date, default: null },
});

deviceSchema.index({ userId: 1, deviceIdHash: 1 }, { unique: true });

module.exports = mongoose.model('Device', deviceSchema);
