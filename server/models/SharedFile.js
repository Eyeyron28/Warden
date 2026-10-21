const mongoose = require('mongoose');

const sharedFileSchema = new mongoose.Schema({
  shareId: { type: String, required: true },
  fileId: { type: String, required: true },
  ciphertext: { type: Buffer, required: true },
  iv: { type: Buffer, required: true },
  authTag: { type: Buffer, required: true },
  sizeBytes: { type: Number, required: true },
  expiresAt: { type: Date, required: true },
});

sharedFileSchema.index({ shareId: 1, fileId: 1 }, { unique: true });
sharedFileSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('SharedFile', sharedFileSchema);
