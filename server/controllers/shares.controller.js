const crypto = require('crypto');
const mongoose = require('mongoose');

const Document = require('../models/Document');
const Share = require('../models/Share');
const SharedFile = require('../models/SharedFile');
const { decryptFile } = require('../utils/crypto');
const {
  generateShareKey,
  encryptForShare,
  pack,
  toBase64Url,
  newShareId,
  newFileId,
  SHARE_ID_RE,
} = require('../utils/shareCrypto');
const limits = require('../utils/shareLimits');
const { getPublicAppUrl } = require('../utils/publicAppUrl');

// Routes are async, but Express doesn't forward rejected promises to
// error-handling middleware on its own - this small wrapper does that so
// every handler below can just `throw` instead of repeating try/catch.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
const badRequest = (message) => httpError(400, message);
const documentNotFound = () => httpError(404, 'Document not found.');
const shareNotFound = () => httpError(404, 'Share not found.');

function assertValidId(id, label = 'document') {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw badRequest(`Invalid ${label} id.`);
  }
}

const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)}MB`;

/** What this owner has used so far, from their still-active shares. */
async function usageFor(userId) {
  const [row] = await Share.aggregate([
    { $match: { ownerUserId: userId, expiresAt: { $gt: new Date() } } },
    { $group: { _id: null, bytes: { $sum: '$totalBytes' }, shares: { $sum: 1 } } },
  ]);
  const usedBytes = row?.bytes ?? 0;
  return {
    usedBytes,
    remainingBytes: Math.max(0, limits.MAX_USER_SHARE_BYTES - usedBytes),
    limitBytes: limits.MAX_USER_SHARE_BYTES,
    perShareLimitBytes: limits.MAX_SHARE_BYTES,
    activeShares: row?.shares ?? 0,
    maxActiveShares: limits.MAX_ACTIVE_SHARES,
    maxDurationHours: limits.MAX_DURATION_HOURS,
  };
}

/**
 * The one place a share is issued - POST /api/documents/:id/share (one file)
 * and POST /api/shares (a set, e.g. a folder's contents) both call this.
 *
 * Owner-only (requireSession). The server holds the vault key for this one
 * request, so it decrypts each selected file and re-encrypts a COPY under a
 * brand-new random share key. That key goes back in the response, inside the
 * link's #fragment, and is never stored: the database gets ciphertext, the
 * encrypted manifest (names, types, folders) and ownership/timing only.
 * Nothing about a share involves the vault key after this function returns.
 */
async function issueShare(req, res, documentIds) {
  const rawHours = req.body.durationHours;
  let hours = limits.DEFAULT_DURATION_HOURS;
  if (rawHours !== undefined && rawHours !== null) {
    if (typeof rawHours !== 'number' && typeof rawHours !== 'string') {
      throw badRequest('durationHours must be a positive number of hours.');
    }
    hours = Number(rawHours);
  }
  if (!Number.isFinite(hours) || hours <= 0) {
    throw badRequest('durationHours must be a positive number of hours.');
  }
  if (hours > limits.MAX_DURATION_HOURS) {
    throw badRequest(`A share link can last at most ${limits.MAX_DURATION_HOURS / 24} days.`);
  }

  if (!documentIds.every((id) => typeof id === 'string')) {
    throw badRequest('Invalid document id.');
  }
  const uniqueIds = [...new Set(documentIds)];
  if (uniqueIds.length === 0) {
    throw badRequest('At least one document is required.');
  }
  if (uniqueIds.length > limits.MAX_SHARE_FILES) {
    throw badRequest(`A share link can include at most ${limits.MAX_SHARE_FILES} documents.`);
  }
  uniqueIds.forEach((id) => assertValidId(id));

  const baseUrl = getPublicAppUrl();
  if (!baseUrl) {
    throw httpError(
      500,
      'No public address is configured for share links. Set PUBLIC_APP_URL (see .env.example) and restart the server.'
    );
  }

  // Limits first, before any decryption work.
  const usage = await usageFor(req.userId);
  if (usage.activeShares >= limits.MAX_ACTIVE_SHARES) {
    throw httpError(
      409,
      `You already have ${limits.MAX_ACTIVE_SHARES} active share links. Revoke one to create another.`
    );
  }

  const objectIds = uniqueIds.map((id) => new mongoose.Types.ObjectId(id));
  const sizes = await Document.aggregate([
    { $match: { _id: { $in: objectIds }, userId: req.userId } },
    { $project: { size: { $binarySize: '$encryptedBlob' } } },
  ]);
  if (sizes.length !== uniqueIds.length) {
    throw documentNotFound();
  }
  const totalBytes = sizes.reduce((sum, row) => sum + row.size, 0);
  if (totalBytes > limits.MAX_SHARE_BYTES) {
    throw httpError(
      413,
      `These files add up to ${mb(totalBytes)}; one share can hold at most ${mb(limits.MAX_SHARE_BYTES)}. Share fewer files.`
    );
  }
  if (usage.usedBytes + totalBytes > limits.MAX_USER_SHARE_BYTES) {
    throw httpError(
      409,
      `Not enough shared storage: this share needs ${mb(totalBytes)} and you have ${mb(usage.remainingBytes)} left of ${mb(limits.MAX_USER_SHARE_BYTES)}. Revoke a share to free space.`
    );
  }

  // At most 20MB of blobs from here on.
  const documents = await Document.find({ _id: { $in: objectIds }, userId: req.userId }).select(
    'filename mimeType folder encryptedBlob iv authTag checksum'
  );
  if (documents.length !== uniqueIds.length) {
    throw documentNotFound();
  }

  const shareId = newShareId();
  const shareKey = generateShareKey();
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);

  const files = [];
  const manifestFiles = [];
  for (const doc of documents) {
    const plaintext = decryptFile(doc.encryptedBlob.toString('base64'), req.dek, doc.iv, doc.authTag);
    const checksum = crypto.createHash('sha256').update(plaintext).digest('hex');
    if (checksum !== doc.checksum) {
      throw httpError(500, 'Integrity check failed on a file, so no share was created.');
    }
    const fileId = newFileId();
    const sealed = encryptForShare(plaintext, shareKey, shareId, fileId);
    files.push({
      shareId,
      fileId,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      authTag: sealed.authTag,
      sizeBytes: sealed.ciphertext.length,
      expiresAt,
    });
    manifestFiles.push({
      id: fileId,
      name: doc.filename,
      mime: doc.mimeType || 'application/octet-stream',
      folder: doc.folder || 'root',
      size: plaintext.length,
    });
  }

  const manifest = encryptForShare(
    Buffer.from(JSON.stringify({ v: 1, files: manifestFiles }), 'utf8'),
    shareKey,
    shareId,
    'manifest'
  );

  try {
    await Share.create({
      shareId,
      ownerUserId: req.userId,
      sourceDocumentIds: documents.map((doc) => doc._id),
      fileCount: files.length,
      totalBytes,
      manifestCipher: manifest.ciphertext,
      manifestIv: manifest.iv,
      manifestAuthTag: manifest.authTag,
      expiresAt,
    });
    await SharedFile.insertMany(files);
  } catch (err) {
    await Promise.allSettled([Share.deleteOne({ shareId }), SharedFile.deleteMany({ shareId })]);
    throw err;
  }

  // The key is returned exactly once, in the fragment, and not stored or
  // logged anywhere. no-store keeps it out of any HTTP cache.
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json({
    id: shareId,
    expiresAt,
    shareUrl: `${baseUrl}/shared/${shareId}#k=${toBase64Url(shareKey)}`,
    entryCount: files.length,
    totalBytes,
    usage: await usageFor(req.userId),
  });
}

/**
 * POST /api/documents/:id/share
 * Body: { durationHours }
 */
const createShare = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);
  await issueShare(req, res, [req.params.id]);
});

/**
 * POST /api/shares
 * Body: { documentIds: string[], durationHours }
 * One link covering many documents (the client resolves a folder selection
 * to its nested documents before calling this).
 */
const createBulkShare = asyncHandler(async (req, res) => {
  const { documentIds } = req.body;
  if (!Array.isArray(documentIds)) {
    throw badRequest('documentIds must be an array.');
  }
  await issueShare(req, res, documentIds);
});

/**
 * GET /api/documents/:id/shares
 * This document's currently-active shares, so the owner can see what is out
 * there before deciding to revoke anything. Owner-only; sourceDocumentIds
 * is used to find them but never returned.
 */
const listShares = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);

  const document = await Document.findOne({ _id: req.params.id, userId: req.userId }).select('_id');
  if (!document) {
    throw documentNotFound();
  }

  const shares = await Share.find({
    ownerUserId: req.userId,
    sourceDocumentIds: document._id,
    expiresAt: { $gt: new Date() },
  })
    .select('shareId expiresAt createdAt fileCount')
    .sort({ createdAt: -1 });

  res.status(200).json(
    shares.map((share) => ({
      id: share.shareId,
      expiresAt: share.expiresAt,
      createdAt: share.createdAt,
      entryCount: share.fileCount,
    }))
  );
});

/**
 * GET /api/shares/usage
 * How much shared storage this owner has used, for the share dialog.
 */
const getUsage = asyncHandler(async (req, res) => {
  res.status(200).json(await usageFor(req.userId));
});

/**
 * DELETE /api/shares/:shareId
 * Revokes a share by deleting it and every encrypted copy at once. 404 for
 * a share that does not exist or belongs to someone else (the two are
 * indistinguishable on purpose).
 */
const revokeShare = asyncHandler(async (req, res) => {
  if (!SHARE_ID_RE.test(req.params.shareId)) {
    throw shareNotFound();
  }
  const result = await Share.deleteOne({ shareId: req.params.shareId, ownerUserId: req.userId });
  if (result.deletedCount === 0) {
    throw shareNotFound();
  }
  await SharedFile.deleteMany({ shareId: req.params.shareId });
  res.status(200).json({ success: true, usage: await usageFor(req.userId) });
});

module.exports = {
  createShare,
  createBulkShare,
  listShares,
  getUsage,
  revokeShare,
};
