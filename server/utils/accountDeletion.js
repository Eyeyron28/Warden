const User = require('../models/User');
const Document = require('../models/Document');
const Folder = require('../models/Folder');
const BackupLog = require('../models/BackupLog');
const PairedDevice = require('../models/PairedDevice');
const PairingToken = require('../models/PairingToken');
const RecoveryRequestToken = require('../models/RecoveryRequestToken');
const Session = require('../models/Session');
const OtpChallenge = require('../models/OtpChallenge');
const RateLimit = require('../models/RateLimit');
const { runInTransaction } = require('./folders');
const { removeShares } = require('./shareCleanup');

/**
 * Permanently removes everything the server holds for one account.
 *
 * What goes (the `deleted` counts it returns are by collection):
 *   - Shares and everything that hangs off them (utils/shareCleanup.js): the
 *     encrypted file copies, visitors' gate progress, emailed-code challenges,
 *     the wrapped keys, verifier hashes, recipient emails and counters inside
 *     the share records, and the rate-limit rows keyed by share id;
 *   - paired devices, pairing and phone-recovery tokens, pending code challenges;
 *   - Documents - which are the stored ciphertext and thumbnails - Folders and
 *     backup log rows;
 *   - rate-limit rows keyed to the account (by id, or by its email address;
 *     rows keyed only by an IP address cannot be tied to a person and stay);
 *   - every Session (so any bearer token stops working), and finally the User,
 *     which carries the password hash, the wrapped vault keys and the
 *     email-verification and password-reset token hashes.
 *
 * Atomic where MongoDB allows it: one transaction, so a failure rolls
 * everything back. Where transactions are unsupported (or `transaction:
 * false`) the steps run in an order that revokes access first and removes the
 * account last, and every step is a delete-by-filter, so running the whole
 * thing again after a failure simply finishes the job. It never creates
 * anything, so a retry cannot make a half-deleted state worse.
 *
 * @param {import('mongoose').Types.ObjectId | string} userId
 * @param {{ email?: string | null, transaction?: boolean }} [options]
 * @returns {Promise<Record<string, number>>} documents deleted per collection
 */
async function deleteAccountData(userId, { email = null, transaction = true } = {}) {
  const run = async (session) => {
    const opts = session ? { session } : {};
    const deleted = {};
    const del = async (label, model, filter) => {
      const result = await model.deleteMany(filter, opts);
      deleted[label] = result?.deletedCount ?? 0;
    };

    // 1. Anything that grants access to the data. Shares first, with everything
    // attached to them (inside the transaction, so a share created a moment ago
    // is included).
    Object.assign(deleted, await removeShares({ ownerUserId: userId }, { session }));
    await del('paireddevices', PairedDevice, { userId });
    await del('pairingtokens', PairingToken, { userId });
    await del('recoveryrequesttokens', RecoveryRequestToken, { userId });
    await del('otpchallenges', OtpChallenge, { userId });
    await del('sessions', Session, { userId });
    // 2. The data itself.
    await del('documents', Document, { userId });
    await del('folders', Folder, { userId });
    await del('backuplogs', BackupLog, { userId });
    // 3. Rate-limit rows that name this account.
    const keys = [String(userId)];
    if (email) keys.push(String(email).trim().toLowerCase());
    await del('ratelimits', RateLimit, { key: { $in: keys } });
    // 4. The account last.
    await del('users', User, { _id: userId });
    return deleted;
  };

  if (!transaction) return run(null);
  return runInTransaction(run);
}

module.exports = { deleteAccountData };
