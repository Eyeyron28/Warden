const mongoose = require('mongoose');

// A single-purpose, bearer-style link to one document. Anyone holding the
// token can view that document until it's revoked or expires - there's no
// separate password or account behind it, so the token itself IS the
// credential (see the 32-byte crypto.randomBytes token in
// controllers/shares.controller.js).
const shareTokenSchema = new mongoose.Schema({
  documentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Document',
    required: true,
  },
  token: {
    type: String,
    required: true,
    unique: true,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
  // Explicit revocation, independent of expiry - lets the owner kill a
  // link early without waiting for it to time out on its own.
  revoked: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('ShareToken', shareTokenSchema);
