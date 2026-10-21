const crypto = require('crypto');
const mongoose = require('mongoose');

const Document = require('../models/Document');
const DocumentVersion = require('../models/DocumentVersion');
const { recordEvent } = require('../utils/audit');
const { encryptFile, decryptFile } = require('../utils/crypto');
const { assertCanStore } = require('../utils/storage');
const { downloadName, contentDisposition } = require('../utils/fileNames');
const { toListSummary } = require('./documents.controller');
const { MAX_VERSIONS, VERSION_MS, sealUpload, bodyOf, applyBody, trimVersions } = require('../utils/versions');
const { assertNotHeld, safeScan, refuse, refuseZip, codesOf } = require('../utils/quarantine');
const { describeReasons, isPlainZip } = require('../utils/fileScanner');
const { logSecurity } = require('../utils/securityLog');

const MAX_NOTE_CHARS = 2000;

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const badRequest = (message) => fail(400, message);
const notFound = (what = 'Document') => fail(404, `${what} not found.`);

function objectId(id, what) {
  if (typeof id !== 'string' || !mongoose.Types.ObjectId.isValid(id)) throw notFound(what);
  return new mongoose.Types.ObjectId(id);
}

async function ownDocument(req, select = null) {
  const _id = objectId(req.params.id, 'Document');
  const query = Document.findOne({ _id, userId: req.userId, deletedAt: null });
  const document = await (select ? query.select(select) : query);
  if (!document) throw notFound('Document');
  return document;
}

function readNote(doc, dek) {
  if (!doc.noteCipher || !doc.noteIv || !doc.noteAuthTag) return null;
  try {
    return decryptFile(doc.noteCipher, dek, doc.noteIv, doc.noteAuthTag).toString('utf8');
  } catch {
    return null;
  }
}

function parseNote(value) {
  if (value === null) return null;
  if (typeof value !== 'string') throw badRequest('note must be text, or null to remove it.');
  const text = value.replace(/\r\n?/g, '\n');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) throw badRequest('A note can only contain text.');
  if (text.length > MAX_NOTE_CHARS) throw badRequest(`A note can be at most ${MAX_NOTE_CHARS} characters.`);
  return text.trim() === '' ? null : text;
}

const setNote = asyncHandler(async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || !('note' in req.body)) throw badRequest('note is required (text, or null to remove it).');
  const note = parseNote(req.body.note);
  const document = await ownDocument(req, 'hasNote noteCipher noteIv noteAuthTag');
  const before = readNote(document, req.dek);

  let update;
  if (note === null) update = { $set: { hasNote: false }, $unset: { noteCipher: '', noteIv: '', noteAuthTag: '' } };
  else {
    const { ciphertext, iv, authTag } = encryptFile(Buffer.from(note, 'utf8'), req.dek);
    update = { $set: { hasNote: true, noteCipher: ciphertext, noteIv: iv, noteAuthTag: authTag } };
  }
  const result = await Document.updateOne({ _id: document._id, userId: req.userId, deletedAt: null }, update, { timestamps: false });
  if (result.matchedCount === 0) throw notFound('Document');

  if (note === null && before !== null) await recordEvent(req, 'note_cleared', { targetId: document._id });
  else if (note !== null && before === null) await recordEvent(req, 'note_set', { targetId: document._id });
  else if (note !== null && note !== before) await recordEvent(req, 'note_changed', { targetId: document._id });

  res.status(200).json({ id: String(document._id), hasNote: note !== null, note });
});

const versionSummary = (row, labels, deviceId) => ({
  id: String(row._id),
  version: row.version,
  size: row.size,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  type: row.sniffedType ?? null,
  device: row.deviceId ? labels.get(String(row.deviceId)) ?? null : null,
  thisDevice: Boolean(row.deviceId && deviceId && String(row.deviceId) === String(deviceId)),
});

const VERSION_LIST_PROJECTION = { version: 1, createdAt: 1, expiresAt: 1, sniffedType: 1, deviceId: 1, size: { $binarySize: '$encryptedBlob' } };

function listVersionRows(userId, documentId) {
  return DocumentVersion.aggregate([{ $match: { userId, documentId } }, { $sort: { version: -1 } }, { $project: VERSION_LIST_PROJECTION }]);
}

const sizeOf = (row) => (Buffer.isBuffer(row.encryptedBlob) ? row.encryptedBlob.length : 0);

function openBody(row, dek) {
  const plaintext = decryptFile(row.encryptedBlob.toString('base64'), dek, row.iv, row.authTag);
  if (crypto.createHash('sha256').update(plaintext).digest('hex') !== row.checksum) {
    throw fail(500, 'Integrity check failed: this document may be corrupted.', { expose: true });
  }
  return plaintext;
}

const uploadVersion = asyncHandler(async (req, res) => {
  const uploaded = req.files?.file?.[0];
  if (!uploaded) throw badRequest('No file uploaded.');
  const document = await ownDocument(req);
  assertNotHeld(document);

  if (isPlainZip(uploaded.originalname, uploaded.buffer)) throw await refuseZip(req);
  const scanned = safeScan({ name: uploaded.originalname, type: uploaded.mimetype, buffer: uploaded.buffer });
  if (scanned.verdict === 'blocked') throw await refuse(req, scanned);
  if (scanned.verdict === 'suspicious') {
    logSecurity('file_refused', { bucket: codesOf(scanned.reasons) });
    await recordEvent(req, 'file_refused', { targetId: document._id, detail: codesOf(scanned.reasons) });
    throw fail(422, 'This new version looks risky, so it was not added and the current version is unchanged. To keep it anyway, upload it as a separate file: it will be held in Quarantine for you to review.', {
      code: 'VERSION_REFUSED',
      reasons: describeReasons(scanned.reasons),
    });
  }

  const incomingChecksum = crypto.createHash('sha256').update(uploaded.buffer).digest('hex');
  if (incomingChecksum === document.checksum) throw fail(409, 'That file is identical to the current version, so nothing was changed.', { code: 'VERSION_IDENTICAL' });

  const oldest = await DocumentVersion.find({ userId: req.userId, documentId: document._id }).sort({ version: 1 }).select('encryptedBlob');
  const evicted = oldest.length >= MAX_VERSIONS ? sizeOf(oldest[0]) : 0;
  await assertCanStore(req.userId, Math.max(0, uploaded.buffer.length + (req.files?.thumb?.[0]?.buffer?.length ?? 0) - evicted));

  const sealed = sealUpload({ buffer: uploaded.buffer, mimetype: uploaded.mimetype, thumb: req.files?.thumb?.[0] }, req.dek);
  const now = new Date();
  const number = (document.versionCounter ?? 0) + 1;

  const kept = await DocumentVersion.create({
    userId: req.userId,
    documentId: document._id,
    version: number,
    ...bodyOf(document),
    deviceId: req.deviceId || null,
    expiresAt: new Date(now.getTime() + VERSION_MS),
  });
  const { set, unset } = applyBody(sealed);
  const swapped = await Document.updateOne(
    { _id: document._id, userId: req.userId, deletedAt: null, authTag: document.authTag, iv: document.iv },
    { $set: set, $unset: unset, $inc: { versionCounter: 1 } }
  );
  if (swapped.matchedCount === 0) {
    await DocumentVersion.deleteOne({ _id: kept._id, userId: req.userId });
    throw fail(409, 'This file was changed somewhere else while you were uploading. Reload it and try again.', { code: 'VERSION_CONFLICT' });
  }
  await trimVersions(req.userId, document._id);
  await recordEvent(req, 'version_created', { targetId: document._id });

  const fresh = await Document.findOne({ _id: document._id, userId: req.userId }).select('-encryptedBlob -thumbCipher');
  res.status(201).json({ ...toListSummary({ ...fresh.toObject(), size: uploaded.buffer.length }), version: number, scan: scanned.verdict });
});

async function ownVersion(req) {
  const documentId = objectId(req.params.id, 'Document');
  const versionId = objectId(req.params.versionId, 'Version');
  const document = await Document.findOne({ _id: documentId, userId: req.userId, deletedAt: null });
  if (!document) throw notFound('Document');
  const version = await DocumentVersion.findOne({ _id: versionId, userId: req.userId, documentId });
  if (!version) throw notFound('Version');
  return { document, version };
}

const restoreVersion = asyncHandler(async (req, res) => {
  const { document, version } = await ownVersion(req);
  assertNotHeld(document);
  await assertCanStore(req.userId, Math.max(0, sizeOf(document) - sizeOf(version)));

  const now = new Date();
  const number = (document.versionCounter ?? 0) + 1;
  const kept = await DocumentVersion.create({
    userId: req.userId,
    documentId: document._id,
    version: number,
    ...bodyOf(document),
    deviceId: req.deviceId || null,
    expiresAt: new Date(now.getTime() + VERSION_MS),
  });
  const { set, unset } = applyBody(bodyOf(version));
  const swapped = await Document.updateOne(
    { _id: document._id, userId: req.userId, deletedAt: null, authTag: document.authTag, iv: document.iv },
    { $set: set, $unset: unset, $inc: { versionCounter: 1 } }
  );
  if (swapped.matchedCount === 0) {
    await DocumentVersion.deleteOne({ _id: kept._id, userId: req.userId });
    throw fail(409, 'This file was changed somewhere else. Reload it and try again.', { code: 'VERSION_CONFLICT' });
  }
  await DocumentVersion.deleteOne({ _id: version._id, userId: req.userId, documentId: document._id });
  await trimVersions(req.userId, document._id);
  await recordEvent(req, 'version_restored', { targetId: document._id });

  const fresh = await Document.findOne({ _id: document._id, userId: req.userId }).select('-encryptedBlob -thumbCipher');
  res.status(200).json({ ...toListSummary({ ...fresh.toObject(), size: sizeOf(version) }), restoredVersion: version.version, newVersion: number });
});

const deleteVersion = asyncHandler(async (req, res) => {
  const { document, version } = await ownVersion(req);
  await DocumentVersion.deleteOne({ _id: version._id, userId: req.userId, documentId: document._id });
  await recordEvent(req, 'version_deleted', { targetId: document._id });
  res.status(204).send();
});

const downloadVersion = asyncHandler(async (req, res) => {
  const { document, version } = await ownVersion(req);
  assertNotHeld(document);
  const plaintext = openBody(version, req.dek);
  await recordEvent(req, 'download', { targetId: document._id });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDisposition(downloadName(document.filename, plaintext)));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(plaintext);
});

module.exports = {
  MAX_NOTE_CHARS,
  readNote,
  versionSummary,
  listVersionRows,
  setNote,
  uploadVersion,
  restoreVersion,
  deleteVersion,
  downloadVersion,
};
