const mongoose = require('mongoose');

const Document = require('../models/Document');

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
  const knownIds = (knownDocumentIds || []).filter((id) => mongoose.Types.ObjectId.isValid(id));

  const documents = await Document.find({ _id: { $nin: knownIds } }).sort({ createdAt: -1 });
  res.status(200).json(documents.map(toSyncPayload));
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
  const { newDocuments } = req.body;
  if (!Array.isArray(newDocuments) || newDocuments.length === 0) {
    throw badRequest('newDocuments must be a non-empty array.');
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

    if (!filename || !encryptedBlob || !iv || !authTag || !checksum) {
      throw badRequest(
        'Each document requires filename, encryptedBlob, iv, authTag, and checksum.'
      );
    }

    // eslint-disable-next-line no-await-in-loop -- small batches, sequential writes are fine here
    const document = await Document.create({
      filename,
      folder: folder || undefined, // let the schema default ("root") apply
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
