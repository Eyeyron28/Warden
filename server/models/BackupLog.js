const mongoose = require('mongoose');

// Records each export run so GET /api/backup/status can report the most
// recent backup without recomputing anything. Kept as its own collection
// rather than fields on User: backup metadata is operational, not
// security-critical, and this leaves room for a future backup-history
// view without touching the auth record.
const backupLogSchema = new mongoose.Schema(
  {
    documentCount: {
      type: Number,
      required: true,
    },
    // Where this backup was written (targetPath/warden-backup).
    backupPath: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

module.exports = mongoose.model('BackupLog', backupLogSchema);
