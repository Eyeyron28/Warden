const mongoose = require('mongoose');

// One encrypted copy of one file in a share (see models/Share.js). Its own
// collection because a share can hold up to 20MB and a Mongo document is
// capped at 16MB. Only ciphertext is stored: the key is in the link, not here.
const sharedFileSchema = new mongoose.Schema({
  shareId: { type: String, required: true },
  fileId: { type: String, required: true },
  ciphertext: { type: Buffer, required: true },
  iv: { type: Buffer, required: true },
  authTag: { type: Buffer, required: true },
  sizeBytes: { type: Number, required: true },
  // Same expiry as the parent share, so the copies disappear with it.
  expiresAt: { type: Date, required: true },
});

sharedFileSchema.index({ shareId: 1, fileId: 1 }, { unique: true });
sharedFileSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('SharedFile', sharedFileSchema);
