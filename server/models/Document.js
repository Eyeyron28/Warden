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
    folder: {
      type: String,
      default: 'root',
    },
    encryptedBlob: {
      type: Buffer,
    },
    iv: {
      type: String,
      required: true,
    },
    authTag: {
      type: String,
      required: true,
    },
    checksum: {
      type: String,
      required: true,
    },
    mimeType: {
      type: String,
      required: true,
    },
    originDevice: {
      type: String,
      enum: ['pc', 'phone', 'restored'],
      required: true,
    },
    expiryDate: {
      type: Date,
    },
    docExpiresAt: {
      type: Date,
      default: null,
      index: true,
    },
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
    sniffedType: { type: String, default: null },
    previewKind: { type: String, enum: ['image', 'pdf', 'none', null], default: null },
    thumbFailedAt: { type: Date, default: null },
    thumbFailReason: { type: String, default: null },
    lastOpenedAt: { type: Date, default: null },
    viewCount: { type: Number, default: 0 },
    downloadCount: { type: Number, default: 0 },
    starred: { type: Boolean, default: false },
    hasNote: { type: Boolean, default: false },
    noteCipher: { type: String },
    noteIv: { type: String },
    noteAuthTag: { type: String },
    versionCounter: { type: Number, default: 0 },
    uploadKey: { type: String },
    scan: {
      verdict: { type: String, enum: ['clean', 'suspicious', 'unchecked'] },
      reasons: { type: [String], default: undefined },
      scannerVersion: { type: Number },
      scannedAt: { type: Date },
    },
    quarantine: {
      state: { type: String, enum: ['held', 'released'] },
      heldAt: { type: Date },
      releasedAt: { type: Date },
    },
    deletedAt: { type: Date, default: null },
    purgeAt: { type: Date, default: null },
    trashBatchId: { type: String, default: null },
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

documentSchema.pre('validate', function requireEncryptedBlob(next) {
  if (!Buffer.isBuffer(this.encryptedBlob)) {
    this.invalidate('encryptedBlob', 'Path `encryptedBlob` is required.', this.encryptedBlob);
  }
  next();
});

documentSchema.index({ userId: 1, folder: 1 });
documentSchema.index({ userId: 1, checksum: 1 });
documentSchema.index({ userId: 1, deletedAt: 1, createdAt: -1 });
documentSchema.index({ userId: 1, deletedAt: 1, sniffedType: 1 });
documentSchema.index({ userId: 1, deletedAt: 1, docExpiresAt: 1 });
documentSchema.index({ userId: 1, 'quarantine.heldAt': -1 }, { partialFilterExpression: { 'quarantine.state': 'held' } });
documentSchema.index({ trashBatchId: 1 }, { sparse: true });
documentSchema.index({ userId: 1, uploadKey: 1 }, { unique: true, partialFilterExpression: { uploadKey: { $type: 'string' } } });
documentSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Document', documentSchema);
