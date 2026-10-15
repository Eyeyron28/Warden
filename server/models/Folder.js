const mongoose = require('mongoose');

// The authoritative record of every folder in an account - one document
// per folder, whether or not anything is filed in it yet. Document.folder
// still holds the full slash-delimited path string a document lives in
// (e.g. "Taxes/2024"), and every such path is guaranteed to have a Folder
// record for each of its segments: every code path that files a document
// somewhere goes through utils/folders.js ensureFolderPath, which resolves
// each segment case-insensitively to the existing folder and creates only
// what's missing.
//
// A folder's own full path is `${parentPath}/${name}` ("" parentPath means
// top level). nameKey is the trimmed, lowercased name - the unique index
// below is what makes "Josh", "josh" and " Josh " the same folder within
// one parent, race-safe, rather than relying on a check-then-insert alone.
//
// autoIndex is off: the old { userId, name } index has to be dropped and
// the old records rewritten into this shape BEFORE the new unique index
// can be built (two legacy records with no nameKey would otherwise collide
// on null). utils/migrateFolders.js does both, then builds the index with
// syncIndexes(), once per database.
const folderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    parentPath: {
      type: String,
      default: '',
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    nameKey: {
      type: String,
      required: true,
    },
    // The folder's look: ids from the server's own lists (utils/folderStyle.js). Absent = the default look, which is how
    // every folder made before this existed is drawn. Neither is part of the path or of the unique index below.
    color: { type: String, default: undefined },
    icon: { type: String, default: undefined },
  },
  {
    timestamps: true,
    autoIndex: false,
  }
);

folderSchema.index({ userId: 1, parentPath: 1, nameKey: 1 }, { unique: true });

module.exports = mongoose.model('Folder', folderSchema);
