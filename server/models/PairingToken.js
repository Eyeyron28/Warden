const mongoose = require('mongoose');

// Short-lived and single-use, deliberately separate from PairedDevice (the
// durable record of an actually-paired phone). Pairing is a live, in-person
// action between two devices the owner controls, so it gets a 5-minute window.
//
// Only the SHA-256 of the token is stored (utils/deviceTokens.js): the raw value
// exists on the owner's screen (in the QR) and nowhere else. Mongo removes the
// row shortly after it expires (TTL index), used or not.
const pairingTokenSchema = new mongoose.Schema(
  {
    // Whose account this QR pairs a device to - set at POST /api/pair/init
    // (session + emailed code) and the ONLY way POST /api/pair/complete finds
    // the account: the phone has no session.
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    // Single-use: flips to true when a phone completes pairing with it.
    used: { type: Boolean, default: false },
    // Wrong master passwords typed against THIS token; the 5th kills it.
    failedAttempts: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

pairingTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PairingToken', pairingTokenSchema);
