const mongoose = require('mongoose');

const shareSchema = new mongoose.Schema({
  shareId: { type: String, required: true, unique: true },
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  sourceDocumentIds: { type: [mongoose.Schema.Types.ObjectId], default: [], index: true },
  fileCount: { type: Number, required: true },
  totalBytes: { type: Number, required: true },
  manifestCipher: { type: Buffer, required: true },
  manifestIv: { type: Buffer, required: true },
  manifestAuthTag: { type: Buffer, required: true },
  labelCipher: { type: String, required: true },
  labelIv: { type: String, required: true },
  labelAuthTag: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },

  ready: { type: Boolean, default: true },
  pendingFinalExpiresAt: { type: Date, default: null },

  maxDownloads: { type: Number, default: null },
  downloadCount: { type: Number, default: 0 },
  openCount: { type: Number, default: 0 },
  lastOpenedAt: { type: Date, default: null },

  recipientEmail: { type: String, default: null },

  passwordSalt: { type: String, default: null },
  passwordKdfN: { type: Number, default: null },
  passwordKdfR: { type: Number, default: null },
  passwordKdfP: { type: Number, default: null },
  passwordWrappedKey: { type: String, default: null },
  passwordVerifierHash: { type: String, default: null },
});

shareSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Share', shareSchema);
