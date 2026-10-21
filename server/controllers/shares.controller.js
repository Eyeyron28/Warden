const crypto = require('crypto');
const mongoose = require('mongoose');

const Document = require('../models/Document');
const Share = require('../models/Share');
const SharedFile = require('../models/SharedFile');
const { encryptFile, decryptFile } = require('../utils/crypto');
const { normalizeRecipient } = require('../utils/email');
const {
  generateShareKey,
  encryptForShare,
  toBase64Url,
  newShareId,
  newFileId,
  SHARE_ID_RE,
} = require('../utils/shareCrypto');
const limits = require('../utils/shareLimits');
const { getPublicAppUrl } = require('../utils/publicAppUrl');
const { recordEvent } = require('../utils/audit');
const { removeShares } = require('../utils/shareCleanup');
const { sha256 } = require('../utils/shareGate');
const { quarantinedError } = require('../utils/quarantine');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  if (status >= 500) error.expose = true;
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
    maxDownloads: limits.MAX_DOWNLOADS,
  };
}

const PURPOSE_MAX = 60;

function parsePurpose(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw badRequest('Purpose must be text.');
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned === '') return null;
  if ([...cleaned].length > PURPOSE_MAX) throw badRequest(`Purpose can be at most ${PURPOSE_MAX} characters.`);
  return cleaned;
}

function parseMaxDownloads(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(number) || number < 1 || number > limits.MAX_DOWNLOADS) {
    throw badRequest(`Maximum downloads must be a whole number from 1 to ${limits.MAX_DOWNLOADS}.`);
  }
  return number;
}

function parseRecipient(value) {
  if (value === undefined || value === null || value === '') return null;
  const address = normalizeRecipient(value);
  if (!address) throw badRequest('Enter one valid email address for the recipient.');
  return address;
}

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function decodeB64(value, label, exactBytes, minBytes = exactBytes, maxBytes = exactBytes) {
  if (typeof value !== 'string' || !B64_RE.test(value) || value.length > 512) throw badRequest(`Invalid ${label}.`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < minBytes || bytes.length > maxBytes) throw badRequest(`Invalid ${label}.`);
  return bytes;
}

function parsePasswordBody(body) {
  const { salt, kdf, wrappedKey, verifier } = body || {};
  decodeB64(salt, 'password salt', 16, 16, 64);
  const { N, r, p } = kdf || {};
  const powerOfTwo = Number.isInteger(N) && (N & (N - 1)) === 0;
  if (!powerOfTwo || N < limits.MIN_KDF_N || N > limits.MAX_KDF_N || r !== 8 || p !== 1) {
    throw badRequest('That password setting is not strong enough.');
  }
  decodeB64(wrappedKey, 'wrapped key', 60);
  const verifierBytes = decodeB64(verifier, 'verifier', 32);
  return {
    passwordSalt: salt,
    passwordKdfN: N,
    passwordKdfR: r,
    passwordKdfP: p,
    passwordWrappedKey: wrappedKey,
    passwordVerifierHash: sha256(verifierBytes),
  };
}

const OWNER_FIELDS = (share, label) => ({
  id: share.shareId,
  name: label.name,
  fileNames: label.names,
  purpose: label.purpose ?? null,
  fileCount: share.fileCount,
  totalBytes: share.totalBytes,
  createdAt: share.createdAt,
  expiresAt: share.expiresAt,
  maxExpiresAt: new Date(share.createdAt.getTime() + limits.MAX_DURATION_HOURS * 3600 * 1000),
  downloadCount: share.downloadCount ?? 0,
  maxDownloads: share.maxDownloads ?? null,
  passwordProtected: Boolean(share.passwordVerifierHash),
  recipientEmail: share.recipientEmail ?? null,
  emailRestricted: Boolean(share.recipientEmail),
});

function readLabel(share, dek) {
  try {
    const parsed = JSON.parse(decryptFile(share.labelCipher, dek, share.labelIv, share.labelAuthTag).toString('utf8'));
    const { names } = parsed;
    const list = Array.isArray(names) ? names.map(String) : [];
    const name = list.length === 0 ? 'Shared files' : list.length === 1 ? list[0] : `${list[0]} and ${share.fileCount - 1} more`;
    const purpose = typeof parsed.purpose === 'string' && parsed.purpose ? parsed.purpose : null;
    return { name, names: list, purpose };
  } catch {
    return { name: 'Shared files', names: [], purpose: null };
  }
}

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
  const maxDownloads = parseMaxDownloads(req.body.maxDownloads);
  const recipientEmail = parseRecipient(req.body.recipientEmail);
  const passwordProtected = req.body.passwordProtected === true;
  const purpose = parsePurpose(req.body.purpose);

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

  const usage = await usageFor(req.userId);
  if (usage.activeShares >= limits.MAX_ACTIVE_SHARES) {
    throw httpError(
      409,
      `You already have ${limits.MAX_ACTIVE_SHARES} active share links. Revoke one to create another.`
    );
  }

  const objectIds = uniqueIds.map((id) => new mongoose.Types.ObjectId(id));
  if (await Document.exists({ _id: { $in: objectIds }, userId: req.userId, ...{ 'quarantine.state': 'held' } })) throw quarantinedError();
  const sizes = await Document.aggregate([
    { $match: { _id: { $in: objectIds }, userId: req.userId, deletedAt: null } },
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

  const documents = await Document.find({ _id: { $in: objectIds }, userId: req.userId, deletedAt: null }).select(
    'filename mimeType folder encryptedBlob iv authTag checksum'
  );
  if (documents.length !== uniqueIds.length) {
    throw documentNotFound();
  }

  const shareId = newShareId();
  const shareKey = generateShareKey();
  const finalExpiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
  const expiresAt = passwordProtected
    ? new Date(Date.now() + limits.PENDING_MINUTES * 60 * 1000)
    : finalExpiresAt;

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
    Buffer.from(
      JSON.stringify(
        purpose ? { v: 2, sharedAt: new Date().toISOString().slice(0, 10), purpose, files: manifestFiles } : { v: 1, files: manifestFiles }
      ),
      'utf8'
    ),
    shareKey,
    shareId,
    'manifest'
  );
  const label = encryptFile(
    Buffer.from(JSON.stringify({ names: documents.slice(0, 20).map((doc) => doc.filename), ...(purpose ? { purpose } : {}) }), 'utf8'),
    req.dek
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
      labelCipher: label.ciphertext,
      labelIv: label.iv,
      labelAuthTag: label.authTag,
      createdAt: new Date(),
      expiresAt,
      ready: !passwordProtected,
      pendingFinalExpiresAt: passwordProtected ? finalExpiresAt : null,
      maxDownloads,
      recipientEmail,
    });
    await SharedFile.insertMany(files);
  } catch (err) {
    await removeShares({ shareId });
    throw err;
  }

  await recordEvent(req, 'share_created', { targetId: shareId });
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json({
    id: shareId,
    expiresAt: passwordProtected ? finalExpiresAt : expiresAt,
    shareUrl: `${baseUrl}/shared/${shareId}#k=${toBase64Url(shareKey)}`,
    entryCount: files.length,
    totalBytes,
    maxDownloads,
    recipientEmail,
    passwordPending: passwordProtected,
    usage: await usageFor(req.userId),
  });
}

const createShare = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);
  await issueShare(req, res, [req.params.id]);
});

const createBulkShare = asyncHandler(async (req, res) => {
  const { documentIds } = req.body;
  if (!Array.isArray(documentIds)) {
    throw badRequest('documentIds must be an array.');
  }
  await issueShare(req, res, documentIds);
});

const listShares = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);

  const document = await Document.findOne({ _id: req.params.id, userId: req.userId, deletedAt: null }).select('_id');
  if (!document) {
    throw documentNotFound();
  }

  const shares = await Share.find({
    ownerUserId: req.userId,
    sourceDocumentIds: document._id,
    ready: true,
    expiresAt: { $gt: new Date() },
  })
    .select('shareId expiresAt createdAt fileCount downloadCount maxDownloads passwordVerifierHash recipientEmail labelCipher labelIv labelAuthTag')
    .sort({ createdAt: -1 });

  res.status(200).json(
    shares.map((share) => ({
      id: share.shareId,
      expiresAt: share.expiresAt,
      createdAt: share.createdAt,
      entryCount: share.fileCount,
      downloadCount: share.downloadCount ?? 0,
      maxDownloads: share.maxDownloads ?? null,
      passwordProtected: Boolean(share.passwordVerifierHash),
      emailRestricted: Boolean(share.recipientEmail),
      purpose: readLabel(share, req.dek).purpose,
    }))
  );
});

const listAllShares = asyncHandler(async (req, res) => {
  const shares = await Share.find({ ownerUserId: req.userId, ready: true, expiresAt: { $gt: new Date() } })
    .select(
      'shareId fileCount totalBytes createdAt expiresAt downloadCount maxDownloads recipientEmail passwordVerifierHash labelCipher labelIv labelAuthTag'
    )
    .sort({ createdAt: -1 });
  res.status(200).json({
    shares: shares.map((share) => OWNER_FIELDS(share, readLabel(share, req.dek))),
    usage: await usageFor(req.userId),
  });
});

const getUsage = asyncHandler(async (req, res) => {
  res.status(200).json(await usageFor(req.userId));
});

async function ownedShare(req, { requireReady = true } = {}) {
  if (!SHARE_ID_RE.test(req.params.shareId)) throw shareNotFound();
  const share = await Share.findOne({ shareId: req.params.shareId, ownerUserId: req.userId });
  if (!share || share.expiresAt.getTime() <= Date.now()) throw shareNotFound();
  if (requireReady && share.ready === false) throw httpError(409, 'This share is still being set up.');
  return share;
}

const updateShare = asyncHandler(async (req, res) => {
  const share = await ownedShare(req);
  const body = req.body || {};
  const set = {};

  if ('durationHours' in body) {
    const hours = Number(body.durationHours);
    if (!Number.isFinite(hours) || hours <= 0) throw badRequest('Choose how long the link should last.');
    const next = new Date(Date.now() + hours * 3600 * 1000);
    const latest = new Date(share.createdAt.getTime() + limits.MAX_DURATION_HOURS * 3600 * 1000);
    if (next.getTime() > latest.getTime()) {
      throw badRequest(`A share can last at most ${limits.MAX_DURATION_HOURS / 24} days in total, so the latest it can end is ${latest.toISOString()}.`);
    }
    set.expiresAt = next;
  }
  if ('maxDownloads' in body) {
    const max = parseMaxDownloads(body.maxDownloads);
    if (max !== null && max <= (share.downloadCount ?? 0)) {
      throw httpError(409, `This share has already been downloaded ${share.downloadCount} time(s). Choose a higher limit, or stop sharing.`);
    }
    set.maxDownloads = max;
  }
  if ('recipientEmail' in body) {
    set.recipientEmail = parseRecipient(body.recipientEmail);
  }
  if (Object.keys(set).length === 0) throw badRequest('Nothing to change.');

  await Share.updateOne({ _id: share._id }, { $set: set });
  if (set.expiresAt) await SharedFile.updateMany({ shareId: share.shareId }, { $set: { expiresAt: set.expiresAt } });

  const fresh = await Share.findOne({ _id: share._id });
  res.status(200).json(OWNER_FIELDS(fresh, readLabel(fresh, req.dek)));
});

const setPassword = asyncHandler(async (req, res) => {
  const share = await ownedShare(req, { requireReady: false });
  const fields = parsePasswordBody(req.body);
  const set = { ...fields };

  if (share.ready === false) {
    set.ready = true;
    set.expiresAt = share.pendingFinalExpiresAt || new Date(Date.now() + limits.DEFAULT_DURATION_HOURS * 3600 * 1000);
    set.pendingFinalExpiresAt = null;
    await SharedFile.updateMany({ shareId: share.shareId }, { $set: { expiresAt: set.expiresAt } });
  }
  await Share.updateOne({ _id: share._id }, { $set: set });
  res.status(200).json({ id: share.shareId, passwordProtected: true, expiresAt: set.expiresAt || share.expiresAt });
});

const getProtection = asyncHandler(async (req, res) => {
  const share = await ownedShare(req);
  if (!share.passwordVerifierHash) {
    res.status(200).json({ passwordProtected: false });
    return;
  }
  res.status(200).json({
    passwordProtected: true,
    salt: share.passwordSalt,
    kdf: { N: share.passwordKdfN, r: share.passwordKdfR, p: share.passwordKdfP },
    wrappedKey: share.passwordWrappedKey,
  });
});

const getOwnerManifest = asyncHandler(async (req, res) => {
  const share = await ownedShare(req);
  res.status(200).json({
    manifest: Buffer.concat([share.manifestIv, share.manifestCipher, share.manifestAuthTag]).toString('base64'),
  });
});

const removePassword = asyncHandler(async (req, res) => {
  const share = await ownedShare(req);
  if (!share.passwordVerifierHash) throw httpError(409, 'This share has no password.');
  await Share.updateOne(
    { _id: share._id },
    {
      $set: {
        passwordSalt: null,
        passwordKdfN: null,
        passwordKdfR: null,
        passwordKdfP: null,
        passwordWrappedKey: null,
        passwordVerifierHash: null,
      },
    }
  );
  res.status(200).json({ id: share.shareId, passwordProtected: false });
});

const revokeShare = asyncHandler(async (req, res) => {
  if (!SHARE_ID_RE.test(req.params.shareId)) {
    throw shareNotFound();
  }
  const counts = await removeShares({ shareId: req.params.shareId, ownerUserId: req.userId });
  if (counts.shares === 0) {
    throw shareNotFound();
  }
  await recordEvent(req, 'share_revoked', { targetId: req.params.shareId });
  res.status(200).json({ success: true, usage: await usageFor(req.userId) });
});

const stopAllShares = asyncHandler(async (req, res) => {
  const counts = await removeShares({ ownerUserId: req.userId });
  await recordEvent(req, 'shares_stopped_all');
  res.status(200).json({ success: true, stopped: counts.shares, usage: await usageFor(req.userId) });
});

module.exports = {
  readLabel,
  createShare,
  createBulkShare,
  listShares,
  listAllShares,
  getUsage,
  updateShare,
  setPassword,
  getProtection,
  getOwnerManifest,
  removePassword,
  revokeShare,
  stopAllShares,
};
