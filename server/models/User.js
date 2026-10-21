const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },

    emailVerified: {
      type: Boolean,
      default: false,
    },
    verificationTokenHash: {
      type: String,
      required: false,
    },
    verificationTokenExpiresAt: {
      type: Date,
      required: false,
    },

    consent: {
      type: new mongoose.Schema({ acceptedAt: { type: Date, required: true }, policyVersion: { type: String, required: true } }, { _id: false }),
      default: undefined,
    },

    passwordHash: {
      type: String,
      required: true,
    },
    salt: {
      type: String,
      required: true,
    },
    recoveryKeyHash: {
      type: String,
      required: true,
    },

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

    dekFingerprint: {
      type: String,
      required: true,
    },

    failedAttempts: {
      type: Number,
      default: 0,
    },
    lockedUntil: {
      type: Date,
      required: false,
    },

    expiryReminders: { type: Boolean, default: true },

    auditHead: {
      seq: { type: Number, default: 0 },
      hash: { type: String, default: '' },
      at: { type: Date, default: null },
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

module.exports = mongoose.model('User', userSchema);
