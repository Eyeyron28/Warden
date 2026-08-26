const mongoose = require('mongoose');

// Short-lived and single-use, deliberately separate from PairedDevice
// (the durable record of an actually-paired phone) and from ShareToken
// (a link handed to someone else, valid for hours/days). Pairing is a
// live, in-person action between two devices the owner already
// controls, so it gets a 5-minute window instead - long enough to open
// the phone's camera, too short to be worth attacking.
const pairingTokenSchema = new mongoose.Schema(
  {
    token: {
      type: String,
      required: true,
      unique: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    // Single-use: once the phone completes pairing with this token, it
    // flips to true and the token can never be used again, even if
    // still within its expiry window.
    used: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

module.exports = mongoose.model('PairingToken', pairingTokenSchema);
