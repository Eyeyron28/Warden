const Document = require('../models/Document');
const TrashFolder = require('../models/TrashFolder');
const DocumentVersion = require('../models/DocumentVersion');
const { maxDocuments } = require('./uploadLimits');

const MB = 1024 * 1024;
const DEFAULT_QUOTA_MB = 25;

const LIVE = Object.freeze({ deletedAt: null });
const TRASHED = Object.freeze({ deletedAt: { $ne: null } });

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
        bytes: { $sum: { $binarySize: { $ifNull: ['$encryptedBlob', ''] } } },
        count: { $sum: 1 },
      },
    },
  ]);
  return { bytes: row?.bytes ?? 0, count: row?.count ?? 0 };
}

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
    Document.countDocuments({ userId, ...LIVE, 'quarantine.state': 'held' }),
  ]);
  const quota = quotaBytes();
  const usedBytes = files.bytes + trashed.bytes + versions.bytes;
  return {
    fileBytes: files.bytes,
    fileCount: Math.max(0, files.count - held),
    heldCount: held,
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

async function assertCanStore(userId, addBytes) {
  const [files, trashed, versions] = await Promise.all([sumFor(userId, LIVE), sumFor(userId, TRASHED), versionsFor(userId)]);
  const quota = quotaBytes();
  const usedBytes = files.bytes + trashed.bytes + versions.bytes;
  const usage = { usedBytes, quotaBytes: quota, availableBytes: Math.max(0, quota - usedBytes) };
  if (usedBytes + addBytes > quota) throw quotaError(usage, addBytes);
  return usage;
}

module.exports = { LIVE, TRASHED, MB, quotaBytes, getUsage, assertCanStore };
