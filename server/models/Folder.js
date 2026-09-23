const mongoose = require('mongoose');

// Lets an owner create an empty folder (Drive-style "New folder") before
// any document is filed into it. Document.folder (a flat string, see
// models/Document.js) is still the source of truth for which folder a
// document actually lives in - this collection exists ONLY so a folder
// name can exist with zero documents in it and still show up in
// GET /api/documents/folders. The moment a document is filed into a name
// that also exists here, both sources agree and nothing conflicts; there
// is no foreign key between them to keep in sync.
const folderSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

module.exports = mongoose.model('Folder', folderSchema);
