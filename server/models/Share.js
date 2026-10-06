const mongoose = require('mongoose');

// A share link's server-side record. Deliberately holds NOTHING that can
// open it: no share key (it exists only in the link's #fragment, which
// browsers never send), no vault key or anything derived from it, no file
// names. File names, types and folder paths live inside `manifest*`, which
// is AES-256-GCM ciphertext under the share key. What is readable here is
// ownership, timing and sizes - and ciphertext length equals file size.
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
  // Encrypted { v, files: [{ id, name, mime, folder, size }] }.
  manifestCipher: { type: Buffer, required: true },
  manifestIv: { type: Buffer, required: true },
  manifestAuthTag: { type: Buffer, required: true },
  createdAt: { type: Date, default: Date.now },
  // TTL: Mongo deletes the record once this passes (within about a minute).
  // The view endpoints also check it themselves rather than waiting.
  expiresAt: { type: Date, required: true },
});

shareSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Share', shareSchema);
