const mongoose = require('mongoose');

const documentVersionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true },
    version: { type: Number, required: true },
    encryptedBlob: { type: Buffer, required: true },
    iv: { type: String, required: true },
    authTag: { type: String, required: true },
    checksum: { type: String, required: true },
    mimeType: { type: String, required: true },
    sniffedType: { type: String, default: null },
    previewKind: { type: String, enum: ['image', 'pdf', 'none', null], default: null },
    thumbCipher: { type: Buffer },
    thumbIv: { type: String },
    thumbAuthTag: { type: String },
    thumbMime: { type: String, enum: ['image/webp', 'image/jpeg'] },
    deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

documentVersionSchema.index({ userId: 1, documentId: 1, version: -1 });
documentVersionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('DocumentVersion', documentVersionSchema);
