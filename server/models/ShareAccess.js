const mongoose = require('mongoose');

const shareAccessSchema = new mongoose.Schema({
  shareId: { type: String, required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  emailOk: { type: Boolean, default: false },
  passwordOk: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
});

shareAccessSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('ShareAccess', shareAccessSchema);
