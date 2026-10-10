const mongoose = require('mongoose');

// A contact's request for access. At most one request per setup is ACTIVE (pending or released) at a time.
// Holds no kit, no code and no file names; the deny token is stored only as a hash.
const emergencyRequestSchema = new mongoose.Schema({
  accessId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmergencyAccess', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: { type: String, enum: ['pending', 'denied', 'released', 'expired', 'cancelled'], default: 'pending' },
  // true while pending or released: a unique partial index makes "one at a time" hold even under a race.
  active: { type: Boolean, default: true },
  requestedAt: { type: Date, required: true },
  releaseAt: { type: Date, required: true },
  claimExpiresAt: { type: Date, required: true },
  lastOwnerReminderAt: { type: Date, default: null },
  denyTokenHash: { type: String, default: null }, // single use; it can ONLY deny
  requestCountry: { type: String, default: null }, // two letters, never an IP address
  deniedAt: { type: Date, default: null },
  deniedBy: { type: String, enum: ['owner', 'email-link', null], default: null },
  approvedEarlyAt: { type: Date, default: null },
  // The moment the owner's email was handed to the mail sender. The waiting period counts from here, and a session can
  // never start without it: a request whose owner could not be told does not exist (see submitRequest).
  ownerNotifiedAt: { type: Date, default: null },
  releaseNoticedAt: { type: Date, default: null }, // the wait ended: the contact and the owner were told (once)
  releasedAt: { type: Date, default: null }, // the first session was started
  finishedAt: { type: Date, default: null },
  // Finished requests are cleaned up 90 days after they finish.
  expiresAt: { type: Date, default: null },
});

emergencyRequestSchema.index({ accessId: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true } });
emergencyRequestSchema.index({ denyTokenHash: 1 }, { sparse: true });
emergencyRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('EmergencyRequest', emergencyRequestSchema);
