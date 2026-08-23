const mongoose = require('mongoose');

const documentSchema = new mongoose.Schema(
  {
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
      required: true,
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
    // Which client originally created/uploaded this document.
    originDevice: {
      type: String,
      enum: ['pc', 'phone'],
      required: true,
    },
    // Optional renewal/expiry date, for documents like IDs or licenses.
    expiryDate: {
      type: Date,
    },
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

module.exports = mongoose.model('Document', documentSchema);
