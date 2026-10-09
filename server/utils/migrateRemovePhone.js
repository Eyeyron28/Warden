const mongoose = require('mongoose');

const MIGRATION_ID = 'remove-phone-vault-v1';

// Rate-limit buckets that only the pairing code used (per account and per connection).
const PAIRING_BUCKETS = ['pair-complete-account', 'pair-complete', 'pair-owner'];

/**
 * One-time, idempotent. Warden is a website now, so everything the phone vault stored goes:
 * paired devices (with their token hashes), pairing tokens, phone-recovery requests, pairing
 * codes still waiting in OtpChallenge, the pairing rate-limit counters, and the phone's upload
 * id on documents. Runs after every successful connection but costs one read once its marker
 * exists. Safe to run twice, or to interrupt: every step is a delete-by-filter, and the marker
 * is written last.
 */
async function migrateRemovePhone() {
  const db = mongoose.connection.db;
  const migrations = db.collection('migrations');
  if (await migrations.findOne({ _id: MIGRATION_ID })) return;

  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name));
  for (const name of ['paireddevices', 'pairingtokens', 'recoveryrequesttokens']) {
    // eslint-disable-next-line no-await-in-loop
    if (existing.has(name)) await db.collection(name).drop().catch(() => {});
  }

  await db.collection('otpchallenges').deleteMany({ purpose: 'pair-device' });
  await db.collection('ratelimits').deleteMany({ bucket: { $in: PAIRING_BUCKETS } });

  const documents = db.collection('documents');
  if (existing.has('documents')) {
    await documents.updateMany({ clientId: { $exists: true } }, { $unset: { clientId: '' } });
    const indexes = await documents.indexes().catch(() => []);
    for (const index of indexes) {
      // eslint-disable-next-line no-await-in-loop
      if (index.key && index.key.clientId === 1) await documents.dropIndex(index.name).catch(() => {});
    }
  }

  await migrations.insertOne({ _id: MIGRATION_ID, at: new Date() });
}

module.exports = migrateRemovePhone;
module.exports.MIGRATION_ID = MIGRATION_ID;
module.exports.PAIRING_BUCKETS = PAIRING_BUCKETS;
