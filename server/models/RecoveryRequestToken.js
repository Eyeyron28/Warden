const mongoose = require('mongoose');

// Short-lived and single-use, same spirit as PairingToken - a live,
// in-person action between two devices the owner already controls (their
// locked-out PC and their already-paired phone), so it gets a 5-minute
// window rather than the days a share link gets.
//
// Two-phase, unlike PairingToken's single `used` flag: `fulfilled` flips
// true once the phone has POSTed its re-wrapped DEK (POST
// /api/auth/recover-via-phone/submit), and `used` flips true once the PC
// has actually completed the recovery with a new master password (POST
// /api/auth/recover-via-phone/complete). Splitting these matters because
// the wrapped DEK material has to be held SOMEWHERE between those two
// requests (the PC only knows the token, not the wrapped material, until
// it polls status and then completes), and this record is that place -
// it never needs to round-trip through the browser at all.
const recoveryRequestTokenSchema = new mongoose.Schema(
  {
    // Which account this recovery request is for - resolved at POST
    // /api/auth/recover-via-phone/init from the email the locked-out
    // owner types in (there's no session to read it from; see
    // controllers/auth.controller.js). POST .../complete resolves the
    // account from THIS field, never a singleton lookup.
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    token: {
      type: String,
      required: true,
      unique: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    fulfilled: {
      type: Boolean,
      default: false,
    },
    used: {
      type: Boolean,
      default: false,
    },

    // The phone's live DEK, re-wrapped under a key derived from this same
    // `token` value (known to both PC and phone only because the owner
    // physically read it off one screen and typed it into the other) -
    // set once, by POST /api/auth/recover-via-phone/submit. Absent until
    // `fulfilled` is true.
    wrappedDEK: {
      type: String,
      required: false,
    },
    wrappedDEKIv: {
      type: String,
      required: false,
    },
    wrappedDEKAuthTag: {
      type: String,
      required: false,
    },
    wrappedDEKSalt: {
      type: String,
      required: false,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

module.exports = mongoose.model('RecoveryRequestToken', recoveryRequestTokenSchema);
