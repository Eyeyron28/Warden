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
    // Salt used to derive the encryption key from the master password
    // (PBKDF2/Argon2). Generated once at first-run setup.
    salt: {
      type: String,
      required: true,
    },
    // Hash of the recovery key. The recovery key itself is shown to the
    // user once at setup and is never stored in plain form.
    recoveryKeyHash: {
      type: String,
      required: true,
    },
    // Count of consecutive failed unlock attempts, for basic
    // lockout/throttling logic to be added later.
    failedAttempts: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

module.exports = mongoose.model('User', userSchema);
