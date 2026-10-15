const crypto = require('crypto');

const Document = require('../models/Document');
const DocumentVersion = require('../models/DocumentVersion');
const { encryptFile } = require('./crypto');
const { encryptThumbnail } = require('./thumbnails');
const { sniffImageType, sniffPreviewKind } = require('./sniff');

/**
 * Version history of a file (models/DocumentVersion.js): the limits, how a new file body is sealed, and the cleanup.
 */

// A file keeps at most this many PREVIOUS versions; making another deletes the oldest.
const MAX_VERSIONS = 3;
// A previous version is kept this long (a TTL index on its expiresAt, the same pattern as Trash).
const VERSION_DAYS = 30;
const VERSION_MS = VERSION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Encrypts an uploaded file body for storage, with exactly what a normal upload records: AES-256-GCM under the vault key, the
 * checksum of the plaintext, the type the BYTES say (never the name or the claimed type) and the preview kind they allow, and
 * the optional preview image (dropped silently when invalid, as on upload).
 */
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

/** The fields of a stored file body (a Document or a DocumentVersion) that are moved between the two. */
const BODY_FIELDS = ['encryptedBlob', 'iv', 'authTag', 'checksum', 'mimeType', 'sniffedType', 'previewKind'];
const THUMB_FIELDS = ['thumbCipher', 'thumbIv', 'thumbAuthTag', 'thumbMime'];

/** Copies the body (and preview, when there is one) of `from` into a plain object. */
function bodyOf(from) {
  const body = {};
  for (const field of BODY_FIELDS) body[field] = from[field] ?? null;
  for (const field of THUMB_FIELDS) if (from[field]) body[field] = from[field];
  return body;
}

/** What a `$set` / `$unset` pair must do to a Document so it holds `body` (a preview that `body` lacks is removed). */
function applyBody(body) {
  const set = {};
  const unset = {};
  for (const field of BODY_FIELDS) set[field] = body[field];
  for (const field of THUMB_FIELDS) {
    if (body[field]) set[field] = body[field];
    else unset[field] = '';
  }
  // A new body means a new preview attempt: the old failure belongs to the old bytes.
  set.thumbFailedAt = null;
  set.thumbFailReason = null;
  return { set, unset };
}

/** Deletes the versions beyond the newest MAX_VERSIONS of one file. Returns how many went. */
async function trimVersions(userId, documentId) {
  const extra = await DocumentVersion.find({ userId, documentId }).sort({ version: -1 }).skip(MAX_VERSIONS).select('_id');
  if (extra.length === 0) return 0;
  const result = await DocumentVersion.deleteMany({ userId, documentId, _id: { $in: extra.map((row) => row._id) } });
  return result?.deletedCount ?? 0;
}

/** Deletes every version (and so every stored byte of it) of files that are gone for good. */
async function dropVersions(userId, documentIds) {
  const ids = (documentIds || []).filter(Boolean);
  if (ids.length === 0) return 0;
  const filter = { documentId: { $in: ids } };
  if (userId) filter.userId = userId;
  const result = await DocumentVersion.deleteMany(filter);
  return result?.deletedCount ?? 0;
}

/**
 * Deletes versions whose file no longer exists. A file removed by the database's own TTL index (Trash retention ended) takes no
 * code path, so this sweep - run with every purge - removes what it left behind. One account, or all (no userId).
 */
async function pruneOrphanVersions(userId = null) {
  const scope = userId ? { userId } : {};
  const owners = await DocumentVersion.distinct('documentId', scope);
  if (owners.length === 0) return 0;
  const alive = new Set((await Document.distinct('_id', { _id: { $in: owners } })).map(String));
  const gone = owners.filter((id) => !alive.has(String(id)));
  return dropVersions(userId, gone);
}

module.exports = { MAX_VERSIONS, VERSION_DAYS, VERSION_MS, sealUpload, bodyOf, applyBody, trimVersions, dropVersions, pruneOrphanVersions };
