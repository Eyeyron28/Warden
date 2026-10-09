const ReminderLog = require('../models/ReminderLog');

/** Removes the reminder rows of files that are gone for good (deleted, purged, emptied from Trash). */
async function dropReminders(userId, fileIds) {
  const ids = (fileIds || []).filter(Boolean);
  if (ids.length === 0) return 0;
  const filter = { fileId: { $in: ids } };
  if (userId) filter.userId = userId;
  const result = await ReminderLog.deleteMany(filter);
  return result?.deletedCount ?? 0;
}

/** Re-arms one file: its expiry date changed, so every threshold may fire again for the new date. */
async function rearmReminders(userId, fileId) {
  return dropReminders(userId, [fileId]);
}

module.exports = { dropReminders, rearmReminders };
