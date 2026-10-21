const ReminderLog = require('../models/ReminderLog');

async function dropReminders(userId, fileIds) {
  const ids = (fileIds || []).filter(Boolean);
  if (ids.length === 0) return 0;
  const filter = { fileId: { $in: ids } };
  if (userId) filter.userId = userId;
  const result = await ReminderLog.deleteMany(filter);
  return result?.deletedCount ?? 0;
}

async function rearmReminders(userId, fileId) {
  return dropReminders(userId, [fileId]);
}

module.exports = { dropReminders, rearmReminders };
