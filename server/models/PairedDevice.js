const mongoose = require('mongoose');

// Not wired up to any route yet - this pass only builds the PC side of
// pairing (generating/displaying the QR). A PairedDevice record gets
// created once the phone-side scan-and-verify flow (next pass) confirms
// the phone's PIN against the vault and the phone commits to storing its
// own wrapped copy of the DEK locally.
const pairedDeviceSchema = new mongoose.Schema({
  // Set during pairing, e.g. "Josh's Phone" - purely a label for the
  // owner's benefit, never used for auth.
  deviceName: {
    type: String,
    required: false,
  },

  // Same wrap-the-DEK pattern as the password/recovery KEKs on User: a
  // COPY of the vault's DEK, wrapped under a key derived from the
  // phone's own PIN (set during pairing), so the phone can decrypt its
  // locally-synced documents using only something it holds itself -
  // no dependency on the PC being reachable after the initial pairing.
  wrappedDEKPhonePin: {
    type: String,
    required: true,
  },
  wrappedDEKPhonePinIv: {
    type: String,
    required: true,
  },
  wrappedDEKPhonePinAuthTag: {
    type: String,
    required: true,
  },
  wrappedDEKPhonePinSalt: {
    type: String,
    required: true,
  },

  pairedAt: {
    type: Date,
    default: Date.now,
  },
  // Lets the owner revoke a paired phone's access (from the PC) without
  // needing the phone present - mirrors ShareToken.revoked.
  revoked: {
    type: Boolean,
    default: false,
  },
});

module.exports = mongoose.model('PairedDevice', pairedDeviceSchema);
