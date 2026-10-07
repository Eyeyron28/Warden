/**
 * Permanently removes everything in Trash whose 30 days are over, for every
 * account - the encrypted file, its thumbnail, and the trashed-folder entries.
 *
 * You normally don't need this: MongoDB's TTL index on `purgeAt` removes expired
 * items on its own, and each account's own requests purge theirs. It exists for
 * a deterministic sweep (a cron, a one-off after an outage) on a host with no
 * long-running process.
 *
 *   node scripts/purge-trash.js            dry run (default): counts, deletes NOTHING
 *   node scripts/purge-trash.js --confirm  actually deletes
 *
 * Connects to MONGO_URI from the environment / .env. Prints the database NAME
 * (never the URI, which holds credentials).
 */
require('dotenv').config();

const mongoose = require('mongoose');

const Document = require('../models/Document');
const TrashFolder = require('../models/TrashFolder');
const { purgeExpired } = require('../utils/trash');

async function main() {
  const confirm = process.argv.includes('--confirm');
  const unknown = process.argv.slice(2).filter((arg) => arg !== '--confirm');
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(' ')}. The only option is --confirm.`);
    process.exit(2);
  }
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set.');
    process.exit(2);
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    const now = new Date();
    console.log(`Database: ${mongoose.connection.name}`);
    if (!confirm) {
      const documents = await Document.countDocuments({ purgeAt: { $lte: now } });
      const folders = await TrashFolder.countDocuments({ purgeAt: { $lte: now } });
      console.log('DRY RUN - nothing was deleted.');
      console.log(`Expired trashed files that would be deleted: ${documents}`);
      console.log(`Expired trashed folders that would be deleted: ${folders}`);
      console.log('Run again with --confirm to delete them.');
      return;
    }
    const result = await purgeExpired(null, now);
    console.log(`Deleted ${result.deletedDocuments} expired trashed file(s) and ${result.deletedFolders} expired trashed folder(s).`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
