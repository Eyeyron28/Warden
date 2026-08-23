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
    // Hash of the (decrypted) file content, used to verify integrity after
    // sync/backup.
    checksum: {
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
