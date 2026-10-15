const mongoose = require('mongoose');

/**
 * A PREVIOUS version of a file: what it held before it was replaced (or before another version was restored over it).
 *
 * Stored exactly like the file itself: AES-256-GCM under the account's vault key, with its own IV and auth tag, inline in the
 * record (so deleting the record deletes the bytes - there is nowhere else they live). The optional preview thumbnail is kept
 * with it, encrypted the same way, so restoring brings the matching preview back.
 *
 * A version lives 30 days (the TTL index on expiresAt, the same pattern as Trash), at most 3 per file (utils/versions.js), and
 * goes when its file is purged from Trash or its account is deleted (utils/versions.js dropVersions / pruneOrphanVersions).
 * Its bytes count against the account's storage quota (utils/storage.js).
 */
const documentVersionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true },
    // 1, 2, 3 ... counted per file and never reused (Document.versionCounter), so "version 4" is never two different things.
    version: { type: Number, required: true },
    encryptedBlob: { type: Buffer, required: true },
    iv: { type: String, required: true },
    authTag: { type: String, required: true },
    // SHA-256 of the plaintext, checked again on download, as for the file itself.
    checksum: { type: String, required: true },
    mimeType: { type: String, required: true },
    sniffedType: { type: String, default: null },
    previewKind: { type: String, enum: ['image', 'pdf', 'none', null], default: null },
    thumbCipher: { type: Buffer },
    thumbIv: { type: String },
    thumbAuthTag: { type: String },
    thumbMime: { type: String, enum: ['image/webp', 'image/jpeg'] },
    // The device (a Device record of this account) that made the change that created this version; null when unknown.
    deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', default: null },
    // MongoDB removes the record, bytes included, when this passes (30 days after it was made).
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

documentVersionSchema.index({ userId: 1, documentId: 1, version: -1 });
documentVersionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('DocumentVersion', documentVersionSchema);
