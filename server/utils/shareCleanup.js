const Share = require('../models/Share');
const SharedFile = require('../models/SharedFile');
const ShareAccess = require('../models/ShareAccess');
const OtpChallenge = require('../models/OtpChallenge');
const RateLimit = require('../models/RateLimit');

/**
 * Removes shares AND everything that hangs off them, in one place, so that
 * stopping a share, stopping all of them, a share reaching its download limit,
 * a vault wipe and account deletion can never disagree about what "gone" means:
 *   - the encrypted file copies (SharedFile);
 *   - visitors' gate progress (ShareAccess) and any emailed-code challenges for
 *     the share (OtpChallenge, purpose share-email);
 *   - rate-limit rows keyed by the share id (password and code-email budgets);
 *   - the share record itself, with its wrapped key, verifier hash, recipient
 *     email and counters.
 *
 * Every step is a delete-by-filter, so it can run again after a failure.
 *
 * @param {object} filter which shares, e.g. { ownerUserId } or { shareId }
 * @param {{ session?: any }} [options] a MongoDB session when inside a transaction
 * @returns {Promise<Record<string, number>>} documents deleted per collection
 */
async function removeShares(filter, { session = null } = {}) {
  const opts = session ? { session } : {};
  const query = Share.find(filter).select('shareId');
  const shares = await (session ? query.session(session) : query);
  const shareIds = shares.map((share) => share.shareId);

  const counts = {};
  const del = async (label, model, where) => {
    const result = await model.deleteMany(where, opts);
    counts[label] = result?.deletedCount ?? 0;
  };

  await del('sharedfiles', SharedFile, { shareId: { $in: shareIds } });
  await del('shareaccess', ShareAccess, { shareId: { $in: shareIds } });
  await del('sharecodechallenges', OtpChallenge, { purpose: 'share-email', shareId: { $in: shareIds } });
  await del('sharerates', RateLimit, { key: { $in: shareIds } });
  await del('shares', Share, filter);
  return counts;
}

module.exports = { removeShares };
