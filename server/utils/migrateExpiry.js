const mongoose = require('mongoose');

const MIGRATION_ID = 'doc-expires-at-v1';

/**
 * One-time, idempotent. Documents saved before "Expires on" had its own name carry the date as expiryDate: copy it
 * (cut to its UTC day) into docExpiresAt, which is what the daily reminders read, and drop the old field. The
 * marker is written last, so an interrupted run simply runs again.
 */
async function migrateExpiry() {
  const db = mongoose.connection.db;
  const migrations = db.collection('migrations');
  if (await migrations.findOne({ _id: MIGRATION_ID })) return;
  const documents = db.collection('documents');
  await documents.updateMany(
    { expiryDate: { $type: 'date' }, docExpiresAt: { $in: [null] } },
    [{ $set: { docExpiresAt: { $dateTrunc: { date: '$expiryDate', unit: 'day' } } } }, { $unset: 'expiryDate' }]
  );
  await documents.updateMany({ expiryDate: { $exists: true } }, { $unset: { expiryDate: '' } });
  await migrations.insertOne({ _id: MIGRATION_ID, at: new Date() });
}

module.exports = migrateExpiry;
