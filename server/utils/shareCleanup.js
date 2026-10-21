const Share = require('../models/Share');
const SharedFile = require('../models/SharedFile');
const ShareAccess = require('../models/ShareAccess');
const OtpChallenge = require('../models/OtpChallenge');
const RateLimit = require('../models/RateLimit');

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
