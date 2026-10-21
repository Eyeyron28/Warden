const mongoose = require('mongoose');

const MIGRATION_ID = 'doc-expires-at-v1';

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
