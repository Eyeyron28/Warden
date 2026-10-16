const mongoose = require('mongoose');

const { EVENT_TYPES } = require('../utils/auditTypes');

// One thing that happened on an account. NO file names, share purposes, e-mail addresses, IP addresses
// or content: only ids, a coarse country and a time. Names are looked up when the log is READ (and show
// "deleted file" once the file is gone).
//
// The events of one account form a hash chain (utils/audit.js): `hash` = HMAC-SHA-256(key, prevHash ||
// this event's fields). `expiresAt` is `at` plus the retention (AUDIT_RETENTION_DAYS, default 30); Mongo
// removes the oldest events itself, and the oldest one left is the chain's trusted starting point.
const auditEventSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', default: null },
  type: { type: String, enum: [...EVENT_TYPES], required: true },
  targetId: { type: String, default: null },
  at: { type: Date, required: true },
  country: { type: String, default: null },
  // Who did it, when it was not the owner's own session: 'emergency' (an Emergency Access contact). Signed in the chain.
  actor: { type: String, enum: ['emergency', null], default: null },
  // Quarantine events only: the scanner's reason CODES (never a name or content), e.g. 'PDF_ACTIVE,TYPE_MISMATCH'. Signed in the chain when set.
  detail: { type: String, default: null },
  seq: { type: Number, required: true },
  prevHash: { type: String, default: '' },
  hash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
});

auditEventSchema.index({ userId: 1, seq: 1 }, { unique: true });
auditEventSchema.index({ userId: 1, at: -1 });
// "Frequently used" counts one account's `view` events of the last 30 days.
auditEventSchema.index({ userId: 1, type: 1, at: -1 });
auditEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AuditEvent', auditEventSchema);
