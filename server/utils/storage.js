const Document = require('../models/Document');
const TrashFolder = require('../models/TrashFolder');
const DocumentVersion = require('../models/DocumentVersion');
const { maxDocuments } = require('./uploadLimits');

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
async function versionsFor(userId) {
  const [row] = await DocumentVersion.aggregate([
    { $match: { userId } },
    { $group: { _id: null, bytes: { $sum: { $binarySize: '$encryptedBlob' } }, count: { $sum: 1 } } },
  ]);
  return { bytes: row?.bytes ?? 0, count: row?.count ?? 0 };
}

async function getUsage(userId) {
  const [files, trashed, versions, trashedFolders, loose, held] = await Promise.all([
    sumFor(userId, LIVE),
    sumFor(userId, TRASHED),
    versionsFor(userId),
    TrashFolder.countDocuments({ userId }),
    Document.countDocuments({ userId, ...TRASHED, trashBatchId: null }),
    // Files held in Quarantine: they count toward the bytes (they are stored) but are not part of the file count.
    Document.countDocuments({ userId, ...LIVE, 'quarantine.state': 'held' }),
  ]);
  const quota = quotaBytes();
  // Previous versions of files (models/DocumentVersion.js) count against the same quota as the files themselves.
  const usedBytes = files.bytes + trashed.bytes + versions.bytes;
  return {
    fileBytes: files.bytes,
    fileCount: Math.max(0, files.count - held),
    heldCount: held,
    // Every document the account holds (live, held and in Trash) against the most it may hold (utils/uploadLimits.js): the Upload dialog
    // says so before sending when a batch would not fit.
    documentCount: files.count + trashed.count,
    documentLimit: maxDocuments(),
    trashBytes: trashed.bytes,
    trashCount: loose + trashedFolders,
    versionBytes: versions.bytes,
    versionCount: versions.count,
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

/**
 * Throws a 413 STORAGE_QUOTA error if adding `addBytes` would pass the account's quota.
 *
 * It reads only what the check needs - the bytes of the vault, of Trash and of earlier versions, three small aggregates sent
 * together - and not the item counts the storage meter also shows (getUsage), which cost two more round trips on every upload.
 */
async function assertCanStore(userId, addBytes) {
  const [files, trashed, versions] = await Promise.all([sumFor(userId, LIVE), sumFor(userId, TRASHED), versionsFor(userId)]);
  const quota = quotaBytes();
  const usedBytes = files.bytes + trashed.bytes + versions.bytes;
  const usage = { usedBytes, quotaBytes: quota, availableBytes: Math.max(0, quota - usedBytes) };
  if (usedBytes + addBytes > quota) throw quotaError(usage, addBytes);
  return usage;
}

module.exports = { LIVE, TRASHED, MB, quotaBytes, getUsage, assertCanStore };
