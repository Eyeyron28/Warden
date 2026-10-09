const mongoose = require('mongoose');

// One document per account. Multi-user: `email` is the account's real
// identity now (lowercased/trimmed, unique), everything else keeps the
// exact crypto design the single-vault app already used - it just applies
// per-account instead of globally. There is still exactly one DEK per
// account, wrapped under the password and the recovery key the same way.
const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254, // RFC 5321
    },

    // Set once POST /api/auth/verify-email consumes a valid token. Login
    // is refused (after the password check - see auth.controller.js
    // login) until this is true.
    emailVerified: {
      type: Boolean,
      default: false,
    },
    // SHA-256 of the current email-verification token, never the token
    // itself - same "store only the hash" pattern as recovery/reset
    // tokens below. Cleared once consumed or replaced by a fresh signup
    // attempt against an unverified account.
    verificationTokenHash: {
      type: String,
      required: false,
    },
    verificationTokenExpiresAt: {
      type: Date,
      required: false,
    },

    // Hash of the master password (never the password itself).
    passwordHash: {
      type: String,
      required: true,
    },
    // Salt used to derive the key-encryption key from the master password.
    // Generated once at signup.
    salt: {
      type: String,
      required: true,
    },
    // Hash of the recovery key. The recovery key itself is shown to the
    // user once at signup and is never stored in plain form. Its salt is
    // embedded in this string (see utils/crypto.js hashRecoveryKey) and
    // doubles as the salt used to derive the recovery-key KEK below.
    recoveryKeyHash: {
      type: String,
      required: true,
    },

    // Documents are encrypted with a single Data Encryption Key (DEK) per
    // account, generated once at signup and never regenerated - not even
    // when the master password is reset. The DEK itself is never stored
    // directly; it's stored "wrapped" (encrypted) under two independently-
    // derived keys, so either the password or the recovery key alone is
    // enough to recover it. This indirection is what makes password reset
    // possible without losing access to documents already encrypted with
    // the old password: resetting the password only re-wraps the existing
    // DEK under a new password-derived key - it never touches the DEK or
    // re-encrypts any document.
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
    // at signup and never changed since the DEK itself never changes. Lets
    // a password reset check that a recovery key (or a phone's copy)
    // really opens THIS account's vault before anything is rewritten.
    dekFingerprint: {
      type: String,
      required: true,
    },

    // Count of consecutive failed login attempts since the last lockout
    // (or since the last successful login). Resets to 0 either time.
    failedAttempts: {
      type: Number,
      default: 0,
    },
    // Set once failedAttempts crosses the lockout threshold; login is
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
