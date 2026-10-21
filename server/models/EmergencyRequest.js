const mongoose = require('mongoose');

const emergencyRequestSchema = new mongoose.Schema({
  accessId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmergencyAccess', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: { type: String, enum: ['pending', 'denied', 'released', 'expired', 'cancelled'], default: 'pending' },
  active: { type: Boolean, default: true },
  requestedAt: { type: Date, required: true },
  releaseAt: { type: Date, required: true },
  claimExpiresAt: { type: Date, required: true },
  lastOwnerReminderAt: { type: Date, default: null },
  denyTokenHash: { type: String, default: null },
  requestCountry: { type: String, default: null },
  deniedAt: { type: Date, default: null },
  deniedBy: { type: String, enum: ['owner', 'email-link', null], default: null },
  approvedEarlyAt: { type: Date, default: null },
  ownerNotifiedAt: { type: Date, default: null },
  releaseNoticedAt: { type: Date, default: null },
  releasedAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null },
});

emergencyRequestSchema.index({ accessId: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true } });
emergencyRequestSchema.index({ denyTokenHash: 1 }, { sparse: true });
emergencyRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('EmergencyRequest', emergencyRequestSchema);
