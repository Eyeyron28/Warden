const mongoose = require('mongoose');

// One pending login: the password has been verified and a 6-digit code has
// been emailed, but NO session exists yet. Single use, short lived.
//
// What it holds, and what it deliberately does not:
//   - the code is stored only as HMAC-SHA-256(salt, code) - never the code;
//   - the vault key (DEK) is stored only WRAPPED under a random
//     `challengeKey` that exists nowhere on the server: it lives in the
//     challengeToken (`<challengeId>.<challengeKey>`) handed to the browser,
//     exactly like a session's key (utils/sessionStore.js). A database leak
//     while someone is mid-login therefore cannot unwrap the DEK.
// Verifying the code consumes the challenge and only then creates the real
// session.
// Codes for people without an account (a share's recipient, an emergency contact) carry no wrapped key.
// 'signup' codes belong to an address that has no account yet: no user, no key, and (see utils/signupCodes.js) no password.
const NO_WRAPPED_KEY = new Set(['share-email', 'emergency-request', 'emergency-session', 'signup']);

const otpChallengeSchema = new mongoose.Schema({
  // Absent only for a 'signup' code: nobody exists yet. Every other purpose belongs to an account.
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required() { return this.purpose !== 'signup'; } },
  // What this code is FOR. Every lookup includes it, so a login code can never
  // authorise deleting an account, nor a delete code log anyone in.
  purpose: { type: String, enum: ['login', 'delete-account', 'share-email', 'password-reset', 'emergency-setup', 'emergency-request', 'emergency-session', 'signup'], default: 'login', required: true },
  // 'share-email' codes belong to one visitor's access session on one share
  // (userId is the share's OWNER, so deleting the account removes them too).
  shareId: { type: String, default: null, index: true },
  accessId: { type: String, default: null },
  // A 'signup' code is found by an HMAC of the address (never the address itself): at most one live code per address.
  subjectKey: { type: String, default: null },
  // A look-alike made for an address that has no (verified) account, so the
  // password-reset screen behaves the same for every address. Never emailed and
  // never able to succeed (see utils/otpChallenge.js).
  decoy: { type: Boolean, default: false },
  codeHash: { type: String, required: true }, // hex HMAC-SHA-256
  salt: { type: String, required: true }, // hex, the HMAC key
  attempts: { type: Number, default: 0 }, // wrong-or-right guesses so far
  resendCount: { type: Number, default: 0 },
  lastSentAt: { type: Date, required: true },
  // A share-email code has no key to protect (the visitor is not signed in), so
  // these three exist only for login and delete-account challenges.
  wrappedDek: { type: String, required() { return !NO_WRAPPED_KEY.has(this.purpose); } },
  wrappedDekIv: { type: String, required() { return !NO_WRAPPED_KEY.has(this.purpose); } },
  wrappedDekAuthTag: { type: String, required() { return !NO_WRAPPED_KEY.has(this.purpose); } },
  // TTL: Mongo reaps the document shortly after this passes; the controller
  // also checks it itself rather than waiting.
  expiresAt: { type: Date, required: true },
});

otpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpChallengeSchema.index({ subjectKey: 1 }, { unique: true, partialFilterExpression: { subjectKey: { $type: 'string' } } });

module.exports = mongoose.model('OtpChallenge', otpChallengeSchema);
