const mongoose = require('mongoose');

// One visitor's progress through a share's gates (email code, password).
// Created when the viewer opens a link; the random access token is returned
// once, only its SHA-256 is stored, and the viewer sends it in a header (never
// the URL). Ciphertext of a gated share is only served to a token whose
// record has passed every gate the share has. Short-lived, TTL-reaped.
const shareAccessSchema = new mongoose.Schema({
  shareId: { type: String, required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  emailOk: { type: Boolean, default: false },
  passwordOk: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
});

shareAccessSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('ShareAccess', shareAccessSchema);
