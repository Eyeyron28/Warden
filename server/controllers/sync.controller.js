const mongoose = require('mongoose');

const Document = require('../models/Document');
const { serializeThumbnail } = require('../utils/thumbnails');
const { ensureFolderPath, listFolderPaths, toDocumentFolder } = require('../utils/folders');

// Routes are async, but Express doesn't forward rejected promises to
// error-handling middleware on its own - this small wrapper does that so
// every handler below can just `throw` instead of repeating try/catch.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

const DEFAULT_MIME_TYPE = 'application/octet-stream';

/**
 * Full sync payload for one document, including the encrypted blob -
 * unlike documents.controller.js's toListSummary, which is metadata-only.
 * encryptedBlob is base64-encoded since it's crossing JSON, not the raw
 * Buffer the server stores it as.
 */
function toSyncPayload(doc) {
  return {
    id: doc._id,
    filename: doc.filename,
    folder: doc.folder,
    encryptedBlob: doc.encryptedBlob.toString('base64'),
    iv: doc.iv,
    authTag: doc.authTag,
    checksum: doc.checksum,
    mimeType: doc.mimeType,
    expiryDate: doc.expiryDate,
    originDevice: doc.originDevice,
    syncStatus: doc.syncStatus,
    createdAt: doc.createdAt,
    // Still ciphertext (thumbCipher/thumbIv/thumbAuthTag) - copied as stored,
    // and only present when the document has a preview. Scoped by userId
    // like every other field here, since the query above is.
    ...serializeThumbnail(doc),
  };
}

/**
 * POST /api/sync/pull
 * requireDeviceAuth. Body: { knownDocumentIds: string[] }
 * Returns full data for every Document not already in that list - "what
 * does the phone not have yet". No conflict resolution or deletion sync:
 * the phone decides what it's missing purely from its own local id list,
 * this just fills the gap.
 */
const pullDocuments = asyncHandler(async (req, res) => {
  const { knownDocumentIds } = req.body;
  if (knownDocumentIds !== undefined && !Array.isArray(knownDocumentIds)) {
    throw badRequest('knownDocumentIds must be an array.');
  }

  // Local-only ids (e.g. the dev test page's crypto.randomUUID() sample
  // documents) are never valid Mongo ObjectIds - filtering them out here
  // avoids a Mongoose cast error rather than requiring the phone to sort
  // its own ids into "real" vs "local-only" before asking.
  const knownIds = (knownDocumentIds || []).filter(
    (id) => typeof id === 'string' && mongoose.Types.ObjectId.isValid(id)
  );

  const [newDocuments, index, folderPaths] = await Promise.all([
    Document.find({ userId: req.userId, deletedAt: null, _id: { $nin: knownIds } }).sort({ createdAt: -1 }),
    // Metadata-only listing of EVERY document on this account - this is
    // what lets the phone notice PC-side deletes (an id it holds that's
    // missing here) and renames/moves (same id, different filename/
    // folder/expiryDate), which the "new to you" list above can never
    // express.
    Document.find({ userId: req.userId, deletedAt: null }, 'filename folder expiryDate'),
    listFolderPaths(req.userId),
  ]);

  const folders = folderPaths.filter((name) => name !== 'root');

  res.status(200).json({
    documents: newDocuments.map(toSyncPayload),
    index: index.map((doc) => ({
      id: doc._id,
      filename: doc.filename,
      folder: doc.folder,
      expiryDate: doc.expiryDate,
    })),
    folders,
  });
});

/**
 * POST /api/sync/push
 * requireDeviceAuth. Body: { newDocuments: [{ localId?, filename, folder,
 * encryptedBlob (base64), iv, authTag, checksum, expiryDate?, mimeType? }] }
 * Content arrives already encrypted BY THE PHONE under the DEK it
 * unwrapped locally - plaintext never crosses this endpoint, and the
 * server has no session-derived key here to decrypt with even if it
 * wanted to (requireDeviceAuth is not requireSession).
 *
 * mimeType is optional since the phone has no upload UI yet (documents
 * pushed for now come from the dev test page's local-only samples) - it
 * falls back to a generic binary type when absent.
 *
 * `localId`, if given, is echoed back in the response's idMap so the
 * caller can replace its local-only IndexedDB record (keyed by that
 * local id) with the canonical server _id, instead of holding an
 * orphaned local-only copy alongside the now-real one.
 */
const pushDocuments = asyncHandler(async (req, res) => {
  const { newDocuments = [], newFolders = [] } = req.body;
  if (!Array.isArray(newDocuments) || !Array.isArray(newFolders)) {
    throw badRequest('newDocuments and newFolders must be arrays.');
  }
  if (newDocuments.length === 0 && newFolders.length === 0) {
    throw badRequest('Nothing to push.');
  }

  // Empty folders created on the phone. Same implicit-creation rule as
  // every other path (utils/folders.js ensureFolderPath): a phone can't
  // create "josh" next to an existing "Josh" - it resolves into it.
  for (const name of newFolders) {
    if (typeof name !== 'string') continue;
    // eslint-disable-next-line no-await-in-loop
    await ensureFolderPath(req.userId, name);
  }

  const idMap = [];

  for (const item of newDocuments) {
    const {
      localId,
      filename,
      folder,
      encryptedBlob,
      iv,
      authTag,
      checksum,
      expiryDate,
      mimeType,
    } = item || {};

    // encryptedBlob may be '' (a 0-byte file encrypts to an empty ciphertext).
    // Every field is type-checked as a string before it reaches Mongoose.
    const stringFields = [filename, encryptedBlob, iv, authTag, checksum];
    const optionalStrings = [localId, folder, expiryDate, mimeType];
    if (
      !stringFields.every((value) => typeof value === 'string') ||
      !optionalStrings.every((value) => value === undefined || value === null || typeof value === 'string')
    ) {
      throw badRequest('Each document field must be a string.');
    }
    if (!filename || !iv || !authTag || !checksum) {
      throw badRequest(
        'Each document requires filename, encryptedBlob, iv, authTag, and checksum.'
      );
    }

    // eslint-disable-next-line no-await-in-loop -- small batches, sequential writes are fine here
    const document = await Document.create({
      userId: req.userId,
      filename,
      // eslint-disable-next-line no-await-in-loop
      folder: toDocumentFolder(await ensureFolderPath(req.userId, folder || '')),
      encryptedBlob: Buffer.from(encryptedBlob, 'base64'),
      iv,
      authTag,
      checksum,
      mimeType: mimeType || DEFAULT_MIME_TYPE,
      originDevice: 'phone',
      expiryDate: expiryDate || undefined,
      syncStatus: 'synced',
    });

    idMap.push({ localId: localId ?? null, id: document._id });
  }

  res.status(201).json({ idMap });
});

module.exports = { pullDocuments, pushDocuments };
