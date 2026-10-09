const Document = require('../models/Document');
const TrashFolder = require('../models/TrashFolder');

const MB = 1024 * 1024;
const DEFAULT_QUOTA_MB = 25;

/**
 * The ONE definition of "in the vault" and "in Trash", used by every list, by
 * the storage meter and by the quota check, so they cannot disagree.
 *
 * Both are plain query filters, never aggregation expressions: a document
 * written before Trash existed has NO deletedAt field, which a query
 * `{ deletedAt: null }` matches (it is live) but an aggregation comparison such
 * as `{ $ne: ['$deletedAt', null] }` treats as "set" (missing is not null
 * there). That mismatch once counted old files as Trash in the meter while the
 * Trash page, which lists by query, showed nothing.
 */
const LIVE = Object.freeze({ deletedAt: null });
const TRASHED = Object.freeze({ deletedAt: { $ne: null } });

/** Per-account storage limit in bytes (STORAGE_QUOTA_MB, default 25). */
function quotaBytes() {
  const configured = Number(process.env.STORAGE_QUOTA_MB);
  return (Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_QUOTA_MB) * MB;
}

async function sumFor(userId, filter) {
  const [row] = await Document.aggregate([
    { $match: { userId, ...filter } },
    {
      $group: {
        _id: null,
        // A file's size is its ciphertext (= plaintext) length; the small preview image is not counted.
        bytes: { $sum: { $binarySize: { $ifNull: ['$encryptedBlob', ''] } } },
        count: { $sum: 1 },
      },
    },
  ]);
  return { bytes: row?.bytes ?? 0, count: row?.count ?? 0 };
}

/**
 * What an account stores: files in the vault, and what waits in Trash (still
 * encrypted until it is removed for good). `trashCount` counts what the Trash
 * page lists: files trashed on their own plus trashed folders (a folder's own
 * files are inside its entry). Encrypted share copies are NOT in `usedBytes`:
 * they have their own, separate limit (utils/shareLimits.js).
 */
async function getUsage(userId) {
  const [files, trashed, trashedFolders, loose] = await Promise.all([
    sumFor(userId, LIVE),
    sumFor(userId, TRASHED),
    TrashFolder.countDocuments({ userId }),
    Document.countDocuments({ userId, ...TRASHED, trashBatchId: null }),
  ]);
  const quota = quotaBytes();
  const usedBytes = files.bytes + trashed.bytes;
  return {
    fileBytes: files.bytes,
    fileCount: files.count,
    trashBytes: trashed.bytes,
    trashCount: loose + trashedFolders,
    usedBytes,
    quotaBytes: quota,
    availableBytes: Math.max(0, quota - usedBytes),
  };
}

function quotaError(usage, addBytes) {
  // Says what happened and what to do; never prints a "0.0 MB" figure for a full account.
  const todo = 'Delete files or empty Trash to make room, then try again.';
  const message =
    usage.availableBytes < 50 * 1024
      ? `Your storage is full. This needs ${(addBytes / MB).toFixed(1)} MB. ${todo}`
      : `Not enough storage: this needs ${(addBytes / MB).toFixed(1)} MB but only ${(usage.availableBytes / MB).toFixed(1)} MB of your ${Math.round(usage.quotaBytes / MB)} MB is free. ${todo}`;
  const error = new Error(message);
  error.status = 413;
  error.code = 'STORAGE_QUOTA';
  return error;
}

/** Throws a 413 STORAGE_QUOTA error if adding `addBytes` would pass the account's quota. */
async function assertCanStore(userId, addBytes) {
  const usage = await getUsage(userId);
  if (usage.usedBytes + addBytes > usage.quotaBytes) throw quotaError(usage, addBytes);
  return usage;
}

module.exports = { LIVE, TRASHED, MB, quotaBytes, getUsage, assertCanStore };
