const mongoose = require('mongoose');

const NO_WRAPPED_KEY = new Set(['share-email', 'emergency-request', 'emergency-session', 'signup']);

const otpChallengeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required() { return this.purpose !== 'signup'; } },
  purpose: { type: String, enum: ['login', 'delete-account', 'share-email', 'password-reset', 'emergency-setup', 'emergency-request', 'emergency-session', 'signup'], default: 'login', required: true },
  shareId: { type: String, default: null, index: true },
  accessId: { type: String, default: null },
  subjectKey: { type: String, default: null },
  decoy: { type: Boolean, default: false },
  consent: { type: new mongoose.Schema({ acceptedAt: Date, policyVersion: String }, { _id: false }), default: undefined },
  codeHash: { type: String, required: true },
  salt: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  resendCount: { type: Number, default: 0 },
  lastSentAt: { type: Date, required: true },
  wrappedDek: { type: String, required() { return !NO_WRAPPED_KEY.has(this.purpose); } },
  wrappedDekIv: { type: String, required() { return !NO_WRAPPED_KEY.has(this.purpose); } },
  wrappedDekAuthTag: { type: String, required() { return !NO_WRAPPED_KEY.has(this.purpose); } },
  expiresAt: { type: Date, required: true },
});

otpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpChallengeSchema.index({ subjectKey: 1 }, { unique: true, partialFilterExpression: { subjectKey: { $type: 'string' } } });

module.exports = mongoose.model('OtpChallenge', otpChallengeSchema);
