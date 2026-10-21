const mongoose = require('mongoose');

const Folder = require('../models/Folder');
const Document = require('../models/Document');
const { ensureFolderPath, toDocumentFolder } = require('./folders');

const MIGRATION_ID = 'folders-v2-parentPath-nameKey';

async function migrateFolders() {
  const db = mongoose.connection.db;
  const migrations = db.collection('migrations');
  if (await migrations.findOne({ _id: MIGRATION_ID })) return;

  const folders = db.collection('folders');

  const indexes = await folders.indexes().catch(() => []);
  for (const index of indexes) {
    if (index.key && index.key.name === 1 && !index.key.nameKey) {
      // eslint-disable-next-line no-await-in-loop
      await folders.dropIndex(index.name);
    }
  }

  const legacy = await folders.find({ nameKey: { $exists: false } }).toArray();
  if (legacy.length > 0) {
    await folders.deleteMany({ nameKey: { $exists: false } });
  }

  await Folder.syncIndexes();

  for (const record of legacy) {
    if (record.userId && record.name) {
      // eslint-disable-next-line no-await-in-loop
      await ensureFolderPath(record.userId, record.name);
    }
  }

  const pairs = await Document.aggregate([
    { $match: { userId: { $exists: true } } },
    { $group: { _id: { userId: '$userId', folder: '$folder' } } },
  ]);
  for (const { _id } of pairs) {
    // eslint-disable-next-line no-await-in-loop
    const canonical = toDocumentFolder(await ensureFolderPath(_id.userId, _id.folder));
    if (canonical !== _id.folder) {
      // eslint-disable-next-line no-await-in-loop
      await Document.collection.updateMany(
        { userId: _id.userId, folder: _id.folder },
        { $set: { folder: canonical, updatedAt: new Date() } }
      );
    }
  }

  await migrations.updateOne(
    { _id: MIGRATION_ID },
    { $set: { completedAt: new Date() } },
    { upsert: true }
  );
  console.log('Folder migration complete.');
}

module.exports = migrateFolders;
