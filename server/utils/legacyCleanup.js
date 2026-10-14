const User = require('../models/User');
const Document = require('../models/Document');

/**
 * Accounts made by the OLD sign-up (an account first, a verification link after) that were never verified. New sign-ups
 * never create one. After 24 hours such an account can no longer be verified (its link has expired) and, if it holds no
 * documents at all (Trash included), it is only a junk account, so the daily job removes it.
 *
 * Idempotent and cheap: a bounded batch per run. It never touches a verified account, an account younger than 24 hours, or
 * one that holds even a single document.
 */

const MIN_AGE_MS = 24 * 60 * 60 * 1000;
const BATCH = 200;

async function purgeLegacyUnverified({ now = new Date(), limit = BATCH } = {}) {
  const cutoff = new Date(now.getTime() - MIN_AGE_MS);
  const candidates = await User.find({ emailVerified: false, createdAt: { $lt: cutoff } }).select('_id').limit(limit);
  let removed = 0;
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await Document.exists({ userId: candidate._id })) continue;
    // The filter repeats the conditions, so an account verified in the meantime is left alone.
    // eslint-disable-next-line no-await-in-loop
    const result = await User.deleteOne({ _id: candidate._id, emailVerified: false });
    removed += result?.deletedCount ?? 0;
  }
  return { checked: candidates.length, removed };
}

/** How many such accounts exist right now (for reporting only). */
async function countLegacyUnverified({ now = new Date() } = {}) {
  return User.countDocuments({ emailVerified: false, createdAt: { $lt: new Date(now.getTime() - MIN_AGE_MS) } });
}

module.exports = { purgeLegacyUnverified, countLegacyUnverified, MIN_AGE_MS };
