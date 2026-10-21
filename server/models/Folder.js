const mongoose = require('mongoose');

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
