const mongoose = require('mongoose');

// What a correct "password-reset" code buys: one single-use ticket that lets the
// holder choose HOW to set a new password (recovery key, or erase the vault).
//
//   - the ticket is a random value shown only to the browser; only its SHA-256
//     is stored here, so a database leak cannot be replayed;
//   - it belongs to one user and does nothing else: it is not a session and it
//     never carries or unlocks the vault key (the recovery key still has to be
//     typed to keep the vault);
//   - wrong recovery keys are counted against the ticket (5), then it is gone;
//   - it expires after 10 minutes and is deleted the moment a reset succeeds.
const resetTicketSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  attempts: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
});

resetTicketSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('ResetTicket', resetTicketSchema);
