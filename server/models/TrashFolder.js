const mongoose = require('mongoose');

const trashFolderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  batchId: { type: String, required: true, unique: true },
  path: { type: String, required: true },
  parentPath: { type: String, default: '' },
  name: { type: String, required: true },
  subPaths: { type: [String], default: [] },
  itemCount: { type: Number, default: 0 },
  totalBytes: { type: Number, default: 0 },
  deletedAt: { type: Date, required: true },
  purgeAt: { type: Date, required: true },
});

trashFolderSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('TrashFolder', trashFolderSchema);
