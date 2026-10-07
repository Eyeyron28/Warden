const mongoose = require('mongoose');

// A browser the owner chose to trust after a successful emailed-code login
// ("Trust this browser for 30 days"). Such a browser skips the emailed code
// at login - never the master password.
//
// The raw token exists only in the browser's HttpOnly cookie. Only its
// SHA-256 is stored here, so a database leak yields nothing a browser can
// present. No IP address is stored; `label` is a coarse "Browser on OS" taken
// from the User-Agent so the owner can recognise the entry.
const trustedDeviceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  label: { type: String, required: true, maxlength: 80 },
  createdAt: { type: Date, required: true, default: Date.now },
  lastUsedAt: { type: Date, required: true, default: Date.now },
  // Fixed 30 days from creation (not extended by use). Mongo's TTL monitor
  // removes the record; lookups also check it, since the monitor runs ~1/min.
  expiresAt: { type: Date, required: true },
});

trustedDeviceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('TrustedDevice', trustedDeviceSchema);
