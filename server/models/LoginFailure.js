const mongoose = require('mongoose');

// Password-guess counter for the login lockout (utils/loginLimiter.js). One document per HMAC of a normalized email -
// made for any address typed, whether or not an account exists, so the lockout reveals nothing about who is registered.
// Holds no email address and no password. The TTL index removes it once both its counting window and any lock are over.
const loginFailureSchema = new mongoose.Schema({
  key: { type: String, required: true },
  count: { type: Number, default: 0 },
  windowExpiresAt: { type: Date, default: null },
  lockedUntil: { type: Date, default: null },
  // Whether THIS attempt may have its password checked (false: it arrived while the lock was on).
  granted: { type: Boolean, default: true },
  expireAt: { type: Date, required: true },
});

loginFailureSchema.index({ key: 1 }, { unique: true });
loginFailureSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('LoginFailure', loginFailureSchema);
