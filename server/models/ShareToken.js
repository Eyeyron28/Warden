const mongoose = require('mongoose');

// A bearer-style link to one OR MORE documents. Anyone holding the token
// can view every included file until it's revoked or expires - there's no
// separate password or account behind it, so the token itself IS the
// credential (see the 32-byte crypto.randomBytes token in
// controllers/shares.controller.js). Revoking or expiring the link ends
// access to every entry at once; there is no per-entry revocation.
const entrySchema = new mongoose.Schema(
  {
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true },
    // Snapshots taken when the link was issued. The viewer prefers the
    // live Document's values (so a rename is reflected) and falls back to
    // these; they exist so the entry is self-describing.
    filename: { type: String },
    mimeType: { type: String },
  },
  { _id: false }
);

const shareTokenSchema = new mongoose.Schema({
  // The files this link covers. A single-document share is simply an entries
  // array of length 1 - there is no separate single-file code path.
  entries: {
    type: [entrySchema],
    default: [],
  },
  // LEGACY: links created before `entries` existed carry only this. New
  // links never set it; read both via the getDocumentIds() method below.
  documentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Document',
    required: false,
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

  // A COPY of the vault's DEK (one per LINK, not per entry: every document
  // is encrypted under this same DEK, so one wrap unlocks all entries),
  // wrapped (AES-256-GCM) under a key derived
  // from this record's own `token` - NOT under the owner's password or
  // recovery key. This is what lets GET /api/shared/:token (deliberately
  // public, no session) decrypt the one document it points to using only
  // the token from the URL: it derives the same key from that token and
  // unwraps this. wrappedDEKShareSalt is that derivation's salt, generated
  // fresh per share the same way User's password/recovery salts are -
  // the token is already high-entropy, so the salt isn't load-bearing for
  // security here, but keeping it consistent with every other KEK
  // derivation in this app keeps the design auditable rather than a
  // special case to double-check.
  //
  // Because both the wrapping key AND the wrapped ciphertext are unique
  // per share record, one token can only ever unwrap its own
  // wrappedDEKShare - there's no shared secret across shares that would
  // let one token's key material decrypt another share's document.
  wrappedDEKShare: {
    type: String,
    required: true,
  },
  wrappedDEKShareIv: {
    type: String,
    required: true,
  },
  wrappedDEKShareAuthTag: {
    type: String,
    required: true,
  },
  wrappedDEKShareSalt: {
    type: String,
    required: true,
  },
});

// Every document id this link covers, including legacy single-document links.
shareTokenSchema.methods.getDocumentIds = function getDocumentIds() {
  if (this.entries && this.entries.length > 0) {
    return this.entries.map((entry) => entry.documentId);
  }
  return this.documentId ? [this.documentId] : [];
};

module.exports = mongoose.model('ShareToken', shareTokenSchema);
