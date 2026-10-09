const mongoose = require('mongoose');

const Document = require('../models/Document');
const { assertCanStore } = require('../utils/storage');
const { cleanStoredName } = require('../utils/fileNames');
const { ensureFolderPath, listFolderPaths, toDocumentFolder } = require('../utils/folders');

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

const DEFAULT_MIME_TYPE = 'application/octet-stream';

/**
 * Sync, shaped for a serverless host.
 *
 * Vercel caps a function's request body AND response body at 4.5 MB
 * (vercel.com/docs/functions/limitations, "Request body size"). A file can be
 * up to 4 MiB, and base64 inside JSON would make that ~5.3 MB, so ciphertext
 * never travels as JSON here:
 *   - the phone lists METADATA in pages (small, bounded by `limit`);
 *   - then fetches each document's ciphertext on its own, as raw bytes
 *     (<= 4 MiB, under the cap);
 *   - and pushes one document per request as multipart (<= 4 MiB + a few
 *     hundred bytes of envelope).
 * Each call is independent and stateless, so a phone that is days behind, or
 * that dropped its connection halfway, simply asks again from where it was.
 */
const MAX_BLOB_BYTES = 4 * 1024 * 1024;
const DEFAULT_PAGE = 100;
const MAX_PAGE = 200;

function toSyncItem(doc) {
  return {
    id: String(doc._id),
    filename: doc.filename,
    folder: doc.folder,
    size: doc.size ?? 0,
    checksum: doc.checksum,
    iv: doc.iv,
    authTag: doc.authTag,
    mimeType: doc.mimeType,
    expiryDate: doc.expiryDate || null,
    updatedAt: doc.updatedAt,
    // The phone's own id, when it pushed this document: lets it recognise its own
    // upload (whose response it may have lost) instead of downloading a copy.
    clientId: doc.clientId || null,
    // Set for a document that is in Trash: the phone removes its copy; if it is
    // restored later this goes back to null and the phone fetches it again.
    deletedAt: doc.deletedAt || null,
  };
}

/**
 * GET /api/sync/documents?cursor=<id>&limit=<n>
 * requireDeviceAuth. A page of metadata for EVERY document on the account
 * (trashed ones included, flagged by deletedAt), in id order. `nextCursor` is
 * the last id of a full page, or null on the last page. Ciphertext is not in
 * here. A document missing from a completed pass was removed for good.
 */
const listSyncDocuments = asyncHandler(async (req, res) => {
  const { cursor } = req.query;
  if (cursor !== undefined && (typeof cursor !== 'string' || !mongoose.Types.ObjectId.isValid(cursor))) {
    throw badRequest('cursor must be a document id.');
  }
  const asked = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), MAX_PAGE) : DEFAULT_PAGE;

  const match = { userId: req.userId };
  if (cursor) match._id = { $gt: new mongoose.Types.ObjectId(cursor) };

  const rows = await Document.aggregate([
    { $match: match },
    { $sort: { _id: 1 } },
    { $limit: limit + 1 },
    {
      $project: {
        filename: 1,
        folder: 1,
        checksum: 1,
        iv: 1,
        authTag: 1,
        mimeType: 1,
        expiryDate: 1,
        updatedAt: 1,
        deletedAt: 1,
        clientId: 1,
        size: { $binarySize: { $ifNull: ['$encryptedBlob', ''] } },
      },
    },
  ]);

  const page = rows.slice(0, limit);
  res.status(200).json({
    items: page.map(toSyncItem),
    nextCursor: rows.length > limit ? String(page[page.length - 1]._id) : null,
    serverTime: new Date().toISOString(),
  });
});

/**
 * GET /api/sync/folders
 * requireDeviceAuth. Every folder path on the account (excluding "root").
 */
const listSyncFolders = asyncHandler(async (req, res) => {
  const folderPaths = await listFolderPaths(req.userId);
  res.status(200).json({ folders: folderPaths.filter((name) => name !== 'root') });
});

/**
 * GET /api/sync/documents/:id/content
 * requireDeviceAuth. One document's ciphertext as raw bytes (the iv and auth tag
 * are in its metadata). Another account's id, a trashed document and an unknown
 * id are all the same 404.
 */
const getSyncDocumentContent = asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw httpError(404, 'Document not found.');
  const doc = await Document.findOne({ _id: req.params.id, userId: req.userId, deletedAt: null });
  if (!doc || !Buffer.isBuffer(doc.encryptedBlob)) throw httpError(404, 'Document not found.');
  if (doc.encryptedBlob.length > MAX_BLOB_BYTES) {
    // Cannot happen for anything stored through the app; refuse rather than send a response the host would cut off.
    throw httpError(413, 'This document is too large to sync.');
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(doc.encryptedBlob.length));
  res.status(200).end(doc.encryptedBlob);
});

/**
 * POST /api/sync/documents  (multipart/form-data)
 * requireDeviceAuth. Fields: filename, iv, authTag, checksum, clientId, and
 * optionally folder, expiryDate, mimeType; the ciphertext is the "file" part.
 * Content arrives already encrypted BY THE PHONE under the vault key it holds;
 * the server never sees plaintext here.
 *
 * `clientId` (the phone's own id for the document) makes this safe to repeat:
 * if the response was lost and the phone sends it again, the document it already
 * created is returned instead of a second copy.
 */
const pushSyncDocument = asyncHandler(async (req, res) => {
  const file = req.file;
  if (!file) throw badRequest('The encrypted file is missing.');
  const { filename, iv, authTag, checksum, clientId, folder, expiryDate, mimeType } = req.body;

  const required = [filename, iv, authTag, checksum, clientId];
  const optional = [folder, expiryDate, mimeType];
  if (
    !required.every((value) => typeof value === 'string' && value) ||
    !optional.every((value) => value === undefined || typeof value === 'string')
  ) {
    throw badRequest('filename, iv, authTag, checksum and clientId are required text fields.');
  }
  if (clientId.length > 80) throw badRequest('clientId is too long.');

  const existing = await Document.findOne({ userId: req.userId, clientId });
  if (existing) {
    return res.status(200).json({ id: String(existing._id), clientId, duplicate: true });
  }

  await assertCanStore(req.userId, file.buffer.length);

  const document = await Document.create({
    userId: req.userId,
    filename: cleanStoredName(filename),
    folder: toDocumentFolder(await ensureFolderPath(req.userId, folder || '')),
    encryptedBlob: file.buffer,
    iv,
    authTag,
    checksum,
    mimeType: mimeType || DEFAULT_MIME_TYPE,
    originDevice: 'phone',
    expiryDate: expiryDate || undefined,
    syncStatus: 'synced',
    clientId,
  });

  res.status(201).json({ id: String(document._id), clientId, duplicate: false });
});

/**
 * POST /api/sync/folders   Body: { name }
 * requireDeviceAuth. An empty folder created on the phone. Same implicit-
 * creation rule as every other path: it resolves into an existing folder of the
 * same name (any case) rather than making a look-alike.
 */
const pushSyncFolder = asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (typeof name !== 'string' || !name.trim()) throw badRequest('A folder name is required.');
  await ensureFolderPath(req.userId, name);
  res.status(201).json({ success: true });
});

/** The old unpaginated endpoints: gone, with a message the phone can show. */
const syncMoved = (req, res) => {
  res.status(410).json({
    success: false,
    error: { message: 'This version of Warden on your phone is out of date. Reload the app to update it, then sync again.' },
  });
};

module.exports = {
  listSyncDocuments,
  listSyncFolders,
  getSyncDocumentContent,
  pushSyncDocument,
  pushSyncFolder,
  syncMoved,
  MAX_BLOB_BYTES,
  MAX_PAGE,
};
