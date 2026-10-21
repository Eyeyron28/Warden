const crypto = require('crypto');

const Share = require('../models/Share');
const SharedFile = require('../models/SharedFile');
const ShareAccess = require('../models/ShareAccess');
const { SHARE_ID_RE, FILE_ID_RE } = require('../utils/shareCrypto');
const { consumeBudgetCount, isBudgetExhausted } = require('../middleware/rateLimit');
const { logSecurity } = require('../utils/securityLog');
const { removeShares } = require('../utils/shareCleanup');
const gate = require('../utils/shareGate');
const limits = require('../utils/shareLimits');
const { recordEvent } = require('../utils/audit');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function invalidShareLink() {
  const error = new Error('This link is invalid or has expired.');
  error.status = 404;
  return error;
}

function setOpaqueHeaders(res) {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="shared-file.bin"');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

async function findLiveShare(shareId) {
  if (typeof shareId !== 'string' || !SHARE_ID_RE.test(shareId)) throw invalidShareLink();
  const share = await Share.findOne({ shareId });
  if (!share || share.ready === false || share.expiresAt.getTime() <= Date.now()) throw invalidShareLink();
  if (share.maxDownloads != null && (share.downloadCount ?? 0) >= share.maxDownloads) throw invalidShareLink();
  return share;
}

async function accessFor(req, share) {
  return gate.findAccess(share.shareId, req.headers?.['x-share-access']);
}

async function requireClearance(req, share) {
  if (!gate.isGated(share)) return null;
  const access = await accessFor(req, share);
  if (!gate.isCleared(share, access)) throw invalidShareLink();
  return access;
}

const openAccess = asyncHandler(async (req, res) => {
  const share = await findLiveShare(req.params.shareId);
  const { accessToken } = await gate.issueAccess(share);
  await Share.updateOne({ shareId: share.shareId }, { $inc: { openCount: 1 }, $set: { lastOpenedAt: new Date() } });
  await recordEvent(req, 'share_opened', { userId: share.ownerUserId, deviceId: null, targetId: share.shareId });
  noStore(res);
  res.status(200).json({
    accessToken,
    needsEmail: Boolean(share.recipientEmail),
    maskedEmail: share.recipientEmail ? gate.maskEmail(share.recipientEmail) : null,
    needsPassword: Boolean(share.passwordVerifierHash),
    password: share.passwordVerifierHash
      ? { salt: share.passwordSalt, kdf: { N: share.passwordKdfN, r: share.passwordKdfR, p: share.passwordKdfP } }
      : null,
    limited: share.maxDownloads != null,
  });
});

const requestEmailCode = asyncHandler(async (req, res) => {
  const share = await findLiveShare(req.params.shareId);
  const access = await accessFor(req, share);
  if (!access || !share.recipientEmail) throw invalidShareLink();
  noStore(res);
  res.status(200).json(await gate.sendShareCode(share, access));
});

const verifyEmailCode = asyncHandler(async (req, res) => {
  const share = await findLiveShare(req.params.shareId);
  const access = await accessFor(req, share);
  if (!access || !share.recipientEmail) throw invalidShareLink();
  await gate.verifyShareCode(share, access, req.body?.code);
  noStore(res);
  res.status(200).json({ ok: true });
});

const unlockPassword = asyncHandler(async (req, res) => {
  const share = await findLiveShare(req.params.shareId);
  const access = await accessFor(req, share);
  if (!access || !share.passwordVerifierHash) throw invalidShareLink();
  if (share.recipientEmail && !access.emailOk) throw invalidShareLink();

  const budget = { name: 'share-password', key: share.shareId, max: limits.PASSWORD_ATTEMPTS };
  if (await isBudgetExhausted(budget)) {
    const error = new Error('Too many wrong passwords for this link. Please try again later.');
    error.status = 429;
    throw error;
  }

  const wrongPassword = async () => {
    const { count } = await consumeBudgetCount({ ...budget, windowMs: limits.PASSWORD_WINDOW_MS });
    if (count >= 3) logSecurity('share_password_failures', { bucket: 'share-password', count, subject: share.shareId });
  };

  const wrong = () => {
    const error = new Error('That password is incorrect.');
    error.status = 401;
    return error;
  };
  const verifier = req.body?.verifier;
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(verifier) || verifier.length > 64) {
    await wrongPassword();
    throw wrong();
  }
  const bytes = Buffer.from(verifier, 'base64');
  const given = Buffer.from(gate.sha256(bytes), 'hex');
  const stored = Buffer.from(share.passwordVerifierHash, 'hex');
  if (bytes.length !== 32 || given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) {
    await wrongPassword();
    throw wrong();
  }

  await ShareAccess.updateOne({ _id: access._id }, { $set: { passwordOk: true } });
  noStore(res);
  res.status(200).json({
    salt: share.passwordSalt,
    kdf: { N: share.passwordKdfN, r: share.passwordKdfR, p: share.passwordKdfP },
    wrappedKey: share.passwordWrappedKey,
  });
});

const viewSharedManifest = asyncHandler(async (req, res) => {
  const share = await findLiveShare(req.params.shareId);
  await requireClearance(req, share);
  const files = await SharedFile.find({ shareId: share.shareId }).select('fileId sizeBytes');
  if (files.length === 0) throw invalidShareLink();

  noStore(res);
  res.status(200).json({
    expiresAt: share.expiresAt,
    manifest: Buffer.concat([share.manifestIv, share.manifestCipher, share.manifestAuthTag]).toString('base64'),
    files: files.map((file) => ({ id: file.fileId, size: file.sizeBytes })),
  });
});

const viewSharedFile = asyncHandler(async (req, res) => {
  const share = await findLiveShare(req.params.shareId);
  await requireClearance(req, share);
  if (typeof req.params.fileId !== 'string' || !FILE_ID_RE.test(req.params.fileId)) throw invalidShareLink();

  const file = await SharedFile.findOne({ shareId: share.shareId, fileId: req.params.fileId });
  if (!file) throw invalidShareLink();
  const body = Buffer.concat([file.iv, file.ciphertext, file.authTag]);

  const counted = await Share.findOneAndUpdate(
    {
      shareId: share.shareId,
      ready: { $ne: false },
      expiresAt: { $gt: new Date() },
      $or: [{ maxDownloads: null }, { $expr: { $lt: ['$downloadCount', '$maxDownloads'] } }],
    },
    { $inc: { downloadCount: 1 } },
    { new: true }
  );
  if (!counted) throw invalidShareLink();
  if (counted.maxDownloads != null && counted.downloadCount >= counted.maxDownloads) {
    await removeShares({ shareId: share.shareId });
  }

  await recordEvent(req, 'share_downloaded', { userId: share.ownerUserId, deviceId: null, targetId: share.shareId });
  setOpaqueHeaders(res);
  res.setHeader('Content-Length', String(body.length));
  res.status(200).end(body);
});

module.exports = {
  openAccess,
  requestEmailCode,
  verifyEmailCode,
  unlockPassword,
  viewSharedManifest,
  viewSharedFile,
};
