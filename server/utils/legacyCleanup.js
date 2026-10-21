const User = require('../models/User');
const Document = require('../models/Document');

const MIN_AGE_MS = 24 * 60 * 60 * 1000;
const BATCH = 200;

async function purgeLegacyUnverified({ now = new Date(), limit = BATCH } = {}) {
  const cutoff = new Date(now.getTime() - MIN_AGE_MS);
  const candidates = await User.find({ emailVerified: false, createdAt: { $lt: cutoff } }).select('_id').limit(limit);
  let removed = 0;
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await Document.exists({ userId: candidate._id })) continue;
    // eslint-disable-next-line no-await-in-loop
    const result = await User.deleteOne({ _id: candidate._id, emailVerified: false });
    removed += result?.deletedCount ?? 0;
  }
  return { checked: candidates.length, removed };
}

async function countLegacyUnverified({ now = new Date() } = {}) {
  return User.countDocuments({ emailVerified: false, createdAt: { $lt: new Date(now.getTime() - MIN_AGE_MS) } });
}

module.exports = { purgeLegacyUnverified, countLegacyUnverified, MIN_AGE_MS };
