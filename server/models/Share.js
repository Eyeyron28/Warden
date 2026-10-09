const mongoose = require('mongoose');

// A share link's server-side record. Deliberately holds NOTHING that can
// open it: no share key (it exists only in the link's #fragment, or - for a
// password share - only wrapped under a key derived from the password), no
// vault key or anything derived from it, no plaintext file names. File names,
// types and folder paths live inside `manifest*`, which is AES-256-GCM
// ciphertext under the share key. What is readable here is ownership, timing,
// sizes and the access rules the owner chose - and ciphertext length equals
// file size.
//
// A share is a SNAPSHOT: encrypted copies of the files as they were when the
// link was made (models/SharedFile.js). Editing or deleting the original
// document changes nothing here; revoking the share deletes the copies.
const shareSchema = new mongoose.Schema({
  // Random 128-bit id, the only thing in the public URL path.
  shareId: { type: String, required: true, unique: true },
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // Plain ownership link so the owner's per-document share list works. Never
  // returned by the public view endpoint.
  sourceDocumentIds: { type: [mongoose.Schema.Types.ObjectId], default: [], index: true },
  fileCount: { type: Number, required: true },
  totalBytes: { type: Number, required: true },
  // Encrypted { v, files: [{ id, name, mime, folder, size }] } under the SHARE key.
  manifestCipher: { type: Buffer, required: true },
  manifestIv: { type: Buffer, required: true },
  manifestAuthTag: { type: Buffer, required: true },
  // What the owner's share manager shows as the share's name: the file names,
  // encrypted under the owner's VAULT key (the same protection their documents
  // have) and decrypted by the server for the owner's own session only. The
  // browser never holds the vault key and the server never stores the share
  // key, so this is the only way the manager can show names - and it keeps
  // them out of the database in plaintext.
  labelCipher: { type: String, required: true },
  labelIv: { type: String, required: true },
  labelAuthTag: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  // TTL: Mongo deletes the record once this passes (within about a minute).
  // The view endpoints also check it themselves rather than waiting.
  expiresAt: { type: Date, required: true },

  // A password share is created hidden (ready: false, expiring in minutes)
  // until the owner's browser has wrapped the key under the password and sent
  // the wrapped key; only then does it go live with its real expiry.
  ready: { type: Boolean, default: true },
  pendingFinalExpiresAt: { type: Date, default: null },

  // Download limit. A "download" is one delivery of one file's encrypted copy.
  // The count is incremented atomically as the file is served; when it reaches
  // maxDownloads the share and its copies are deleted.
  maxDownloads: { type: Number, default: null },
  downloadCount: { type: Number, default: 0 },
  // How many times a visitor opened the link (not counting the owner), and when last.
  openCount: { type: Number, default: 0 },
  lastOpenedAt: { type: Date, default: null },

  // Optional recipient: the server will only release ciphertext to a visitor
  // who proves they can read this mailbox (a 6-digit emailed code).
  recipientEmail: { type: String, default: null },

  // Optional link password. The password never reaches the server. The
  // browser derives (scrypt) a master secret from it and splits that, by HMAC
  // with distinct labels, into (1) a wrap key that locks the share key, and
  // (2) a verifier. The server keeps only: the salt and cost parameters, the
  // WRAPPED share key, and SHA-256 of the verifier - which is how it
  // rate-limits and gates guesses without being able to open anything.
  passwordSalt: { type: String, default: null },
  passwordKdfN: { type: Number, default: null },
  passwordKdfR: { type: Number, default: null },
  passwordKdfP: { type: Number, default: null },
  passwordWrappedKey: { type: String, default: null },
  passwordVerifierHash: { type: String, default: null },
});

shareSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Share', shareSchema);
