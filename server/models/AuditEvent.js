const mongoose = require('mongoose');

const { EVENT_TYPES } = require('../utils/auditTypes');

const auditEventSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', default: null },
  type: { type: String, enum: [...EVENT_TYPES], required: true },
  targetId: { type: String, default: null },
  at: { type: Date, required: true },
  country: { type: String, default: null },
  actor: { type: String, enum: ['emergency', null], default: null },
  detail: { type: String, default: null },
  seq: { type: Number, required: true },
  prevHash: { type: String, default: '' },
  hash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
});

auditEventSchema.index({ userId: 1, seq: 1 }, { unique: true });
auditEventSchema.index({ userId: 1, at: -1 });
auditEventSchema.index({ userId: 1, type: 1, at: -1 });
auditEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AuditEvent', auditEventSchema);
