const mongoose = require('mongoose');

// Warden is a single-user, single-installation local vault: there is no
// multi-account system, so this collection is expected to hold exactly one
// document per installation. No username/email field is needed because
// nothing ever needs to look a user up by identity - the app just checks
// "does a User document exist yet" (first-run setup) and, once it does,
// verifies the master password against it.
const userSchema = new mongoose.Schema(
  {
    // Hash of the master password (never the password itself).
    passwordHash: {
      type: String,
      required: true,
    },
    // Salt used to derive the key-encryption key from the master password.
    // Generated once at first-run setup.
    salt: {
      type: String,
      required: true,
    },
    // Hash of the recovery key. The recovery key itself is shown to the
    // user once at setup and is never stored in plain form. Its salt is
    // embedded in this string (see utils/crypto.js hashRecoveryKey) and
    // doubles as the salt used to derive the recovery-key KEK below.
    recoveryKeyHash: {
      type: String,
      required: true,
    },

    // Documents are encrypted with a single Data Encryption Key (DEK),
    // generated once at setup and never regenerated - not even when the
    // master password is reset. The DEK itself is never stored directly;
    // it's stored "wrapped" (encrypted) under two independently-derived
    // keys, so either the password or the recovery key alone is enough to
    // recover it. This indirection is what makes password reset possible
    // without losing access to documents already encrypted with the old
    // password: resetting the password only re-wraps the existing DEK
    // under a new password-derived key (see POST /api/auth/recover) - it
    // never touches the DEK or re-encrypts any document.
    wrappedDEKPassword: {
      type: String,
      required: true,
    },
    wrappedDEKPasswordIv: {
      type: String,
      required: true,
    },
    wrappedDEKPasswordAuthTag: {
      type: String,
      required: true,
    },

    wrappedDEKRecovery: {
      type: String,
      required: true,
    },
    wrappedDEKRecoveryIv: {
      type: String,
      required: true,
    },
    wrappedDEKRecoveryAuthTag: {
      type: String,
      required: true,
    },

    // SHA-256 of the DEK itself (utils/crypto.js fingerprintDEK), set once
    // at setup and never changed since the DEK itself never changes. Lets
    // the USB and paired-phone recovery flows confirm the key material
    // they unwrapped from an external source (a backup file, a phone)
    // actually belongs to THIS vault before writing anything - a correct
    // passphrase/token only proves the submitted blob unwraps cleanly, not
    // that the blob came from this installation at all. Not needed by the
    // recovery-key flow, which is already anchored to this same User
    // record's own wrappedDEKRecovery field and has no equivalent risk.
    //
    // Deliberately NOT schema-required: vaults created before this field
    // existed have no value, and a required rule would fail every save of
    // that User (including plain unlock). It's backfilled lazily instead -
    // see backfillDekFingerprint / verifyDekBelongsToVault in
    // controllers/auth.controller.js.
    dekFingerprint: {
      type: String,
      required: false,
    },

    // Count of consecutive failed unlock attempts since the last lockout
    // (or since the last successful unlock). Resets to 0 either time.
    failedAttempts: {
      type: Number,
      default: 0,
    },
    // Set once failedAttempts crosses the lockout threshold; unlock is
    // rejected outright (without even checking the password) while this
    // is present and in the future. Absent/undefined means not locked.
    lockedUntil: {
      type: Date,
      required: false,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

module.exports = mongoose.model('User', userSchema);
