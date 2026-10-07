const crypto = require('crypto');

const Share = require('../models/Share');
const SharedFile = require('../models/SharedFile');
const ShareAccess = require('../models/ShareAccess');
const { SHARE_ID_RE, FILE_ID_RE } = require('../utils/shareCrypto');
const { consumeBudget, isBudgetExhausted } = require('../middleware/rateLimit');
const { removeShares } = require('../utils/shareCleanup');
const gate = require('../utils/shareGate');
const limits = require('../utils/shareLimits');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Deliberately generic and byte-identical for every failure mode - an id
// that never existed (including the 64-character tokens of the old link
// design), a malformed one, one that has expired, one that was revoked, one
// whose download limit is used up, and a gated share the caller has not passed
// the gates of. A prober learns nothing from the difference.
function invalidShareLink() {
  const error = new Error('This link is invalid or has expired.');
  error.status = 404;
  return error;
}

/**
 * This server never decrypts anything shared. It serves ciphertext only; the
 * key is in the link's #fragment (browsers never send it) or, for a password
 * share, wrapped under the password; the viewer decrypts in the browser. So
 * nothing here can serve shared content as a web page, whatever the owner
 * named or typed the file: every file response is opaque bytes, forced to
 * download, with sniffing disabled.
 */
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

/** The visitor's access record, from the X-Share-Access header (never the URL). */
async function accessFor(req, share) {
  return gate.findAccess(share.shareId, req.headers?.['x-share-access']);
}

/** Gated shares serve ciphertext only to an access that passed every gate. */
async function requireClearance(req, share) {
  if (!gate.isGated(share)) return null;
  const access = await accessFor(req, share);
  if (!gate.isCleared(share, access)) throw invalidShareLink();
  return access;
}

/**
 * POST /api/shared/:shareId/access
 * Opens a visitor's access session and says which gates the link has (and, for
 * a password share, the salt and cost needed to derive the verifier). Returns
 * the access token once (stored only hashed). Nothing here is readable without
 * the key; it only tells the viewer what to ask the visitor for.
 */
const openAccess = asyncHandler(async (req, res) => {
  const share = await findLiveShare(req.params.shareId);
  const { accessToken } = await gate.issueAccess(share);
  noStore(res);
  res.status(200).json({
    accessToken,
    needsEmail: Boolean(share.recipientEmail),
    maskedEmail: share.recipientEmail ? gate.maskEmail(share.recipientEmail) : null,
    needsPassword: Boolean(share.passwordVerifierHash),
    // The salt and cost are public parameters: the browser needs them to turn the
    // typed password into the verifier BEFORE it can ask to unlock. Alone they
    // open nothing (the wrapped key is only released for a correct verifier).
    password: share.passwordVerifierHash
      ? { salt: share.passwordSalt, kdf: { N: share.passwordKdfN, r: share.passwordKdfR, p: share.passwordKdfP } }
      : null,
    limited: share.maxDownloads != null,
  });
});

/**
 * POST /api/shared/:shareId/email-code
 * Emails the recipient a 6-digit code (the first call) or sends a new one
 * (a resend). The message holds the code and who shared, never a link or key.
 */
const requestEmailCode = asyncHandler(async (req, res) => {
  const share = await findLiveShare(req.params.shareId);
  const access = await accessFor(req, share);
  if (!access || !share.recipientEmail) throw invalidShareLink();
  noStore(res);
  res.status(200).json(await gate.sendShareCode(share, access));
});

/**
 * POST /api/shared/:shareId/email-verify
 * Body: { code }. The right code passes the email gate for this visit, once.
 */
const verifyEmailCode = asyncHandler(async (req, res) => {
  const share = await findLiveShare(req.params.shareId);
  const access = await accessFor(req, share);
  if (!access || !share.recipientEmail) throw invalidShareLink();
  await gate.verifyShareCode(share, access, req.body?.code);
  noStore(res);
  res.status(200).json({ ok: true });
});

/**
 * POST /api/shared/:shareId/unlock
 * Body: { verifier }. The verifier is derived in the browser from the
 * password (a different value from the key that locks the share key); the
 * server compares its SHA-256. A correct one passes the password gate and
 * releases the salt, cost and WRAPPED share key - which still needs the
 * password to open. Wrong guesses are limited to 5 per share per 15 minutes
 * (and per connection), after which even the right password waits.
 */
const unlockPassword = asyncHandler(async (req, res) => {
  const share = await findLiveShare(req.params.shareId);
  const access = await accessFor(req, share);
  if (!access || !share.passwordVerifierHash) throw invalidShareLink();
  // An emailed-code gate always comes first.
  if (share.recipientEmail && !access.emailOk) throw invalidShareLink();

  const budget = { name: 'share-password', key: share.shareId, max: limits.PASSWORD_ATTEMPTS };
  if (await isBudgetExhausted(budget)) {
    const error = new Error('Too many wrong passwords for this link. Please try again later.');
    error.status = 429;
    throw error;
  }

  const wrong = () => {
    const error = new Error('That password is incorrect.');
    error.status = 401;
    return error;
  };
  const verifier = req.body?.verifier;
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(verifier) || verifier.length > 64) {
    await consumeBudget({ ...budget, windowMs: limits.PASSWORD_WINDOW_MS });
    throw wrong();
  }
  const bytes = Buffer.from(verifier, 'base64');
  const given = Buffer.from(gate.sha256(bytes), 'hex');
  const stored = Buffer.from(share.passwordVerifierHash, 'hex');
  if (bytes.length !== 32 || given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) {
    await consumeBudget({ ...budget, windowMs: limits.PASSWORD_WINDOW_MS });
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

/**
 * GET /api/shared/:shareId
 * Returns the encrypted manifest (iv || ciphertext || tag, base64) and the ids
 * and sizes of the encrypted files. Nothing here is readable without the key,
 * and neither the owner nor the source documents are exposed.
 */
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

/**
 * GET /api/shared/:shareId/files/:fileId
 * One encrypted file as raw bytes: iv (12) || ciphertext || tag (16).
 *
 * Counts as one download: the share's counter is incremented atomically, and
 * only if the limit has not been reached, so two simultaneous requests can
 * never both take the last download. The request that takes it also deletes
 * the share and every encrypted copy once its bytes are in hand.
 */
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
