const mongoose = require('mongoose');

// Created by POST /api/pair/complete. It holds NO key material: the vault key
// is handed to the phone once, over TLS, and the phone wraps it under its own
// PIN in its own storage. Nothing here lets anyone open a document.
const pairedDeviceSchema = new mongoose.Schema({
  // Whose account this device is paired with. requireDeviceAuth resolves this
  // to req.userId on every sync request.
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // A label for the owner's benefit ("Josh's Phone"); never used for auth.
  deviceName: { type: String, required: false },
  // Which browser paired (from its User-Agent), shown in the list and the email.
  browserLabel: { type: String, required: false },

  // SHA-256 of the bearer token for the sync API (utils/deviceTokens.js); the
  // raw token lives only on the phone. Removed on revoke, so a revoked token
  // matches nothing. The index only covers rows that have one.
  tokenHash: { type: String },

  pairedAt: { type: Date, default: Date.now },
  // Updated (at most once a minute) whenever the device calls the sync API.
  lastSeenAt: { type: Date, default: null },
  revoked: { type: Boolean, default: false },
  revokedAt: { type: Date, default: null },
});

pairedDeviceSchema.index({ tokenHash: 1 }, { unique: true, partialFilterExpression: { tokenHash: { $type: 'string' } } });

module.exports = mongoose.model('PairedDevice', pairedDeviceSchema);
