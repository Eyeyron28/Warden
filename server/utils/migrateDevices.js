const mongoose = require('mongoose');

const PairedDevice = require('../models/PairedDevice');
const PairingToken = require('../models/PairingToken');
const { hashToken } = require('./deviceTokens');

const MIGRATION_ID = 'devices-v2-hashed-tokens-no-pin-wrap';

const LEGACY_WRAP_FIELDS = {
  wrappedDEKPhonePin: '',
  wrappedDEKPhonePinIv: '',
  wrappedDEKPhonePinAuthTag: '',
  wrappedDEKPhonePinSalt: '',
};

/**
 * One-time, idempotent. Runs after every successful connection but returns at
 * once when its marker exists.
 *
 *  1. Pairing tokens stored in clear are deleted (they live five minutes, so a
 *     person simply shows a new QR) and their old unique index is dropped.
 *  2. Paired devices stored with a clear device token are converted to its
 *     SHA-256 (the phone keeps working: it still sends the same raw token), and
 *     the old unique index is dropped. A revoked device keeps no token at all.
 *  3. The server-held copy of the vault key wrapped under the phone's PIN is
 *     removed from every device row. Nothing ever read it back.
 */
async function migrateDevices() {
  const db = mongoose.connection.db;
  const migrations = db.collection('migrations');
  if (await migrations.findOne({ _id: MIGRATION_ID })) return;

  const dropIndex = async (collectionName, key) => {
    const collection = db.collection(collectionName);
    const indexes = await collection.indexes().catch(() => []);
    for (const index of indexes) {
      if (index.key && Object.keys(index.key).length === 1 && index.key[key] === 1) {
        // eslint-disable-next-line no-await-in-loop
        await collection.dropIndex(index.name).catch(() => {});
      }
    }
  };

  await dropIndex('pairingtokens', 'token');
  await db.collection('pairingtokens').deleteMany({ tokenHash: { $exists: false } });

  await dropIndex('paireddevices', 'deviceToken');
  const devices = db.collection('paireddevices');
  const legacy = await devices.find({ deviceToken: { $exists: true } }).toArray();
  for (const row of legacy) {
    const tokenHash = row.revoked ? null : hashToken(row.deviceToken);
    // eslint-disable-next-line no-await-in-loop
    await devices.updateOne(
      { _id: row._id },
      tokenHash
        ? { $set: { tokenHash }, $unset: { deviceToken: '' } }
        : { $unset: { deviceToken: '', tokenHash: '' } }
    );
  }
  await devices.updateMany({}, { $unset: LEGACY_WRAP_FIELDS });

  await PairingToken.syncIndexes();
  await PairedDevice.syncIndexes();
  await migrations.insertOne({ _id: MIGRATION_ID, at: new Date() });
}

module.exports = migrateDevices;
