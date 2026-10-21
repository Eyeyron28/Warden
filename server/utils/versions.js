const crypto = require('crypto');

const Document = require('../models/Document');
const DocumentVersion = require('../models/DocumentVersion');
const { encryptFile } = require('./crypto');
const { encryptThumbnail } = require('./thumbnails');
const { sniffImageType, sniffPreviewKind } = require('./sniff');

const MAX_VERSIONS = 3;
const VERSION_DAYS = 30;
const VERSION_MS = VERSION_DAYS * 24 * 60 * 60 * 1000;

function sealUpload({ buffer, mimetype, thumb }, dek) {
  const { ciphertext, iv, authTag } = encryptFile(buffer, dek);
  const thumbnail = thumb ? encryptThumbnail(thumb.buffer, thumb.mimetype, dek) : null;
  return {
    encryptedBlob: Buffer.from(ciphertext, 'base64'),
    iv,
    authTag,
    checksum: crypto.createHash('sha256').update(buffer).digest('hex'),
    mimeType: mimetype,
    sniffedType: sniffImageType(buffer),
    previewKind: sniffPreviewKind(buffer),
    ...(thumbnail || {}),
  };
}

const BODY_FIELDS = ['encryptedBlob', 'iv', 'authTag', 'checksum', 'mimeType', 'sniffedType', 'previewKind'];
const THUMB_FIELDS = ['thumbCipher', 'thumbIv', 'thumbAuthTag', 'thumbMime'];

function bodyOf(from) {
  const body = {};
  for (const field of BODY_FIELDS) body[field] = from[field] ?? null;
  for (const field of THUMB_FIELDS) if (from[field]) body[field] = from[field];
  return body;
}

function applyBody(body) {
  const set = {};
  const unset = {};
  for (const field of BODY_FIELDS) set[field] = body[field];
  for (const field of THUMB_FIELDS) {
    if (body[field]) set[field] = body[field];
    else unset[field] = '';
  }
  set.thumbFailedAt = null;
  set.thumbFailReason = null;
  return { set, unset };
}

async function trimVersions(userId, documentId) {
  const extra = await DocumentVersion.find({ userId, documentId }).sort({ version: -1 }).skip(MAX_VERSIONS).select('_id');
  if (extra.length === 0) return 0;
  const result = await DocumentVersion.deleteMany({ userId, documentId, _id: { $in: extra.map((row) => row._id) } });
  return result?.deletedCount ?? 0;
}

async function dropVersions(userId, documentIds) {
  const ids = (documentIds || []).filter(Boolean);
  if (ids.length === 0) return 0;
  const filter = { documentId: { $in: ids } };
  if (userId) filter.userId = userId;
  const result = await DocumentVersion.deleteMany(filter);
  return result?.deletedCount ?? 0;
}

async function pruneOrphanVersions(userId = null) {
  const scope = userId ? { userId } : {};
  const owners = await DocumentVersion.distinct('documentId', scope);
  if (owners.length === 0) return 0;
  const alive = new Set((await Document.distinct('_id', { _id: { $in: owners } })).map(String));
  const gone = owners.filter((id) => !alive.has(String(id)));
  return dropVersions(userId, gone);
}

module.exports = { MAX_VERSIONS, VERSION_DAYS, VERSION_MS, sealUpload, bodyOf, applyBody, trimVersions, dropVersions, pruneOrphanVersions };
