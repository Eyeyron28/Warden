const mongoose = require('mongoose');

// A folder that was moved to Trash, together with everything in it, as ONE
// entry. Its documents stay in the documents collection (still encrypted)
// marked with the same trashBatchId; the Folder records of its subtree are
// removed while it is in Trash (so a new folder can reuse the name without
// colliding with the unique index) and recreated from `subPaths` on restore.
//
// `purgeAt` is a TTL: MongoDB removes this record - and, because its documents
// carry the same purgeAt, the documents themselves - once the retention period
// is over, with no server process involved. utils/trash.js also purges
// opportunistically, and scripts/purge-trash.js does it for every account.
const trashFolderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  batchId: { type: String, required: true, unique: true },
  // Where it lived: path is the folder's full path, parentPath the folder it was in.
  path: { type: String, required: true },
  parentPath: { type: String, default: '' },
  name: { type: String, required: true },
  // Every folder path in the subtree (including the folder itself and empty subfolders).
  subPaths: { type: [String], default: [] },
  itemCount: { type: Number, default: 0 },
  totalBytes: { type: Number, default: 0 },
  deletedAt: { type: Date, required: true },
  purgeAt: { type: Date, required: true },
});

trashFolderSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('TrashFolder', trashFolderSchema);
