const Share = require('../models/Share');
const SharedFile = require('../models/SharedFile');
const { SHARE_ID_RE, FILE_ID_RE } = require('../utils/shareCrypto');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Deliberately generic and byte-identical for every failure mode - an id
// that never existed (including the 64-character tokens of the old link
// design), a malformed one, one that has expired, one that was revoked. A
// prober learns nothing from the difference.
function invalidShareLink() {
  const error = new Error('This link is invalid or has expired.');
  error.status = 404;
  return error;
}

/**
 * This server never decrypts anything shared. It serves ciphertext only; the
 * key is in the link's #fragment, which browsers never send, and the
 * viewer decrypts in the browser. So nothing here can serve shared content
 * as a web page, whatever the owner named or typed the file: every file
 * response is opaque bytes, forced to download, with sniffing disabled.
 */
function setOpaqueHeaders(res) {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="shared-file.bin"');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

async function findLiveShare(shareId) {
  if (typeof shareId !== 'string' || !SHARE_ID_RE.test(shareId)) throw invalidShareLink();
  const share = await Share.findOne({ shareId });
  if (!share || share.expiresAt.getTime() <= Date.now()) throw invalidShareLink();
  return share;
}

/**
 * GET /api/shared/:shareId
 * Public - the (unknowable without the link) shareId is all it takes to
 * fetch what is, by itself, only ciphertext. Returns the encrypted manifest
 * (iv || ciphertext || tag, base64) and the ids and sizes of the encrypted
 * files. Nothing here is readable without the key from the link, and
 * neither the owner nor the source documents are exposed.
 */
const viewSharedManifest = asyncHandler(async (req, res) => {
  const share = await findLiveShare(req.params.shareId);
  const files = await SharedFile.find({ shareId: share.shareId }).select('fileId sizeBytes');
  if (files.length === 0) throw invalidShareLink();

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.status(200).json({
    expiresAt: share.expiresAt,
    manifest: Buffer.concat([share.manifestIv, share.manifestCipher, share.manifestAuthTag]).toString('base64'),
    files: files.map((file) => ({ id: file.fileId, size: file.sizeBytes })),
  });
});

/**
 * GET /api/shared/:shareId/files/:fileId
 * One encrypted file as raw bytes: iv (12) || ciphertext || tag (16).
 */
const viewSharedFile = asyncHandler(async (req, res) => {
  const share = await findLiveShare(req.params.shareId);
  if (typeof req.params.fileId !== 'string' || !FILE_ID_RE.test(req.params.fileId)) throw invalidShareLink();

  const file = await SharedFile.findOne({ shareId: share.shareId, fileId: req.params.fileId });
  if (!file) throw invalidShareLink();

  const body = Buffer.concat([file.iv, file.ciphertext, file.authTag]);
  setOpaqueHeaders(res);
  res.setHeader('Content-Length', String(body.length));
  res.status(200).end(body);
});

module.exports = { viewSharedManifest, viewSharedFile };
