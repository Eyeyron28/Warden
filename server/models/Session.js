const mongoose = require('mongoose');

// Replaces the old in-memory session Map (server/utils/sessionStore.js) so
// a login survives across serverless invocations/restarts instead of
// vanishing the moment the process that handled it recycles.
//
// The bearer token handed to the client is `sessionId.sessionKey` (both
// random, generated at login - see utils/sessionStore.js createSession).
// Neither half is stored in plain form here:
//   - sessionIdHash is SHA-256(sessionId), looked up on every request -
//     a DB read alone never reveals a usable sessionId.
//   - sessionKey is NEVER stored at all. It only ever exists in the
//     bearer token itself. wrappedDEK/*  is the account's DEK encrypted
//     (AES-256-GCM) under sessionKey, so a database leak alone - without
//     the bearer token a client is actually holding - cannot unwrap any
//     account's DEK.
const sessionSchema = new mongoose.Schema({
  sessionIdHash: {
    type: String,
    required: true,
    unique: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  wrappedDEK: {
    type: String,
    required: true,
  },
  wrappedDEKIv: {
    type: String,
    required: true,
  },
  wrappedDEKAuthTag: {
    type: String,
    required: true,
  },
  // TTL index: Mongo removes the document itself once this passes, no
  // separate cleanup job needed (same cleanup-for-free reasoning as every
  // other short-lived token model in this app, e.g. PairingToken).
  // `refreshSession` (utils/sessionStore.js) bumps this forward on every
  // authenticated request, same sliding-expiry behavior the in-memory
  // store had.
  expiresAt: {
    type: Date,
    required: true,
  },
});

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Session', sessionSchema);
