/**
 * One-off cleanup for the share-link redesign.
 *
 * Old share links stored their secret in plaintext next to a copy of the
 * whole vault key (wrapped under a key derived from that secret), so they
 * cannot be made safe. This removes every one of those records - the whole
 * legacy `sharetokens` collection - and with it the old fields. The new
 * design lives in the separate `shares` and `sharedfiles` collections and is
 * never touched here. Old links then show the generic "invalid or expired"
 * page.
 *
 *   node scripts/purge-legacy-shares.js            dry run (default): counts and
 *                                                  reports, deletes NOTHING
 *   node scripts/purge-legacy-shares.js --confirm  actually deletes
 *
 * Connects to MONGO_URI from the environment / .env. The database NAME is
 * printed so you can check which database it is about to act on; the URI
 * itself (which contains credentials) is never printed.
 */
require('dotenv').config();

const mongoose = require('mongoose');

const LEGACY_COLLECTION = 'sharetokens';

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
  const db = mongoose.connection.db;
  const dbName = mongoose.connection.name;

  try {
    const exists = (await db.listCollections({ name: LEGACY_COLLECTION }).toArray()).length > 0;
    const count = exists ? await db.collection(LEGACY_COLLECTION).countDocuments() : 0;

    if (!confirm) {
      console.log(`DRY RUN - nothing was deleted.`);
      console.log(`Database: ${dbName}`);
      console.log(`Legacy share records that would be deleted: ${count}`);
      console.log('Run again with --confirm to delete them.');
      return;
    }

    if (exists) await db.collection(LEGACY_COLLECTION).drop();
    console.log(`Database: ${dbName}`);
    console.log(`Deleted ${count} legacy share record(s) and dropped the "${LEGACY_COLLECTION}" collection.`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
