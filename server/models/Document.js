const mongoose = require('mongoose');

const documentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    filename: {
      type: String,
      required: true,
    },
    // Simple folder/category organization. Flat string rather than a
    // reference to a Folder collection, since Warden doesn't have nested
    // folder documents (yet).
    folder: {
      type: String,
      default: 'root',
    },
    // The encrypted file content itself. Storing it inline in Mongo is the
    // simplest starting point, but for larger files it may be better to
    // store the encrypted blob on disk and keep only a file path/reference
    // here instead - that's a decision to revisit once the actual
    // encrypt/upload flow is implemented.
    encryptedBlob: {
      type: Buffer,
      // Presence enforced by the pre('validate') hook at the bottom of this
      // file, which (unlike `required: true`) accepts an empty Buffer.
    },
    // Initialization vector used for this file's AES encryption.
    iv: {
      type: String,
      required: true,
    },
    // AES-256-GCM authentication tag, required to decrypt encryptedBlob at
    // all - GCM won't decrypt without it (and rejects the ciphertext if it
    // doesn't match, which is what catches tampering/corruption).
    authTag: {
      type: String,
      required: true,
    },
    // SHA-256 of the ORIGINAL, decrypted file content. Distinct from
    // authTag: authTag verifies the ciphertext wasn't tampered with in
    // storage, this verifies the plaintext still matches what was
    // originally uploaded, which matters once sync/backup starts copying
    // files around.
    checksum: {
      type: String,
      required: true,
    },
    // Original file's MIME type, captured at upload time so it can be
    // restored on the Content-Type header when serving the file back -
    // encryption strips that information, so it has to be stored
    // separately.
    mimeType: {
      type: String,
      required: true,
    },
    // Which client originally created/uploaded this document. ("restored" is
    // kept in the list for rows made when drive backups existed.)
    originDevice: {
      type: String,
      enum: ['pc', 'phone', 'restored'],
      required: true,
    },
    // Optional renewal/expiry date, for documents like IDs or licenses.
    expiryDate: {
      type: Date,
    },
    // Optional encrypted preview thumbnail (see utils/thumbnails.js). Same
    // protection as the file: AES-256-GCM under the account's DEK with its
    // own random IV/auth tag. thumbMime is the type of the PLAINTEXT image
    // (image/webp or image/jpeg) and doubles as the "has a thumbnail" marker,
    // so list queries can leave thumbCipher out entirely. A document without
    // these fields is fully valid.
    thumbCipher: {
      type: Buffer,
      validate: {
        validator: (value) => !value || value.length <= 40 * 1024,
        message: 'thumbCipher must be at most 40KB.',
      },
    },
    thumbIv: {
      type: String,
    },
    thumbAuthTag: {
      type: String,
    },
    thumbMime: {
      type: String,
      enum: ['image/webp', 'image/jpeg'],
    },
    // What the bytes say the file is (utils/sniff.js), from the plaintext at
    // upload: an image mime type, or 'none'. null means "not classified yet"
    // (older files; the Photos endpoint classifies them on demand). This - not
    // the file name or the mimeType the browser claimed - decides what shows in Photos.
    sniffedType: { type: String, default: null },
    // What kind of preview the bytes allow: 'image', 'pdf' or 'none'; null = not known yet
    // (older files and phone uploads; the browser sniffs them when it makes previews).
    previewKind: { type: String, enum: ['image', 'pdf', 'none', null], default: null },
    // A preview that could not be made is recorded, so the same file is not tried again on
    // every run: when, and a short reason code (see PREVIEW_FAILURE_REASONS in utils/thumbnails.js).
    thumbFailedAt: { type: Date, default: null },
    thumbFailReason: { type: String, default: null },
    // Trash (soft delete). A trashed document keeps its encrypted data until it
    // is restored or purged. deletedAt marks it trashed; purgeAt is when it is
    // removed for good (TTL index below); trashBatchId groups documents that were
    // trashed together WITH a folder (null for a file trashed on its own).
    // The phone's own id for a document it pushed (a UUID), so a push that is
    // repeated after a lost response returns the same document, not a copy.
    clientId: { type: String, default: undefined },
    deletedAt: { type: Date, default: null },
    purgeAt: { type: Date, default: null },
    trashBatchId: { type: String, default: null },
    // Whether this document has been synced between the PC backend and the
    // phone client yet.
    syncStatus: {
      type: String,
      enum: ['pending', 'synced'],
      default: 'pending',
    },
  },
  {
    timestamps: true,
  }
);

// Presence check for encryptedBlob, done here instead of `required: true`
// on the path: Mongoose's built-in required check for Buffers also rejects a
// zero-length Buffer, but AES-GCM of an empty file legitimately produces an
// empty ciphertext (integrity lives in authTag). Without this, any 0-byte
// file - an __init__.py or .gitkeep inside an uploaded folder - failed with
// "encryptedBlob is required" and aborted the whole folder upload. A blob
// must still be PRESENT (a real Buffer); it just may be empty.
documentSchema.pre('validate', function requireEncryptedBlob(next) {
  if (!Buffer.isBuffer(this.encryptedBlob)) {
    this.invalidate('encryptedBlob', 'Path `encryptedBlob` is required.', this.encryptedBlob);
  }
  next();
});

// Every list/filter query in documents.controller.js and sync.controller.js
// is userId + something else (folder, expiryDate, checksum) - this compound
// index covers all of them without a separate index per field.
documentSchema.index({ userId: 1, folder: 1 });
documentSchema.index({ userId: 1, checksum: 1 });
documentSchema.index({ userId: 1, deletedAt: 1 });
documentSchema.index({ userId: 1, clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } });
documentSchema.index({ trashBatchId: 1 }, { sparse: true });
// MongoDB removes the whole document (ciphertext and thumbnail included) when
// purgeAt passes. Documents that are not in Trash have no purgeAt, so never expire.
documentSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Document', documentSchema);
