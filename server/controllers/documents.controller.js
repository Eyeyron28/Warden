const crypto = require('crypto');
const mongoose = require('mongoose');

const Document = require('../models/Document');
const { encryptFile, decryptFile } = require('../utils/crypto');

// Routes are async, but Express doesn't forward rejected promises to
// error-handling middleware on its own - this small wrapper does that so
// every handler below can just `throw` instead of repeating try/catch.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function documentNotFound() {
  const error = new Error('Document not found.');
  error.status = 404;
  return error;
}

function assertValidId(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw badRequest('Invalid document id.');
  }
}

const EXPIRING_SOON_THRESHOLD_DAYS = 30;

/**
 * Computes how many calendar days remain until expiryDate, and the coarse
 * status bucket the frontend renders a badge from. Done here rather than
 * on the client so the "0-30 days is expiring_soon" threshold lives in one
 * place instead of being reimplemented wherever a document list is shown.
 *
 * Compares by calendar day (UTC), not raw millisecond difference - the
 * server's current time-of-day shouldn't be able to flip "expires today"
 * to "expired" a few hours early.
 */
function computeExpiryInfo(expiryDate) {
  if (!expiryDate) {
    return { daysUntilExpiry: null, expiryStatus: 'ok' };
  }

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const expiry = Date.UTC(
    expiryDate.getFullYear(),
    expiryDate.getMonth(),
    expiryDate.getDate()
  );
  const daysUntilExpiry = Math.round((expiry - today) / MS_PER_DAY);

  let expiryStatus;
  if (daysUntilExpiry < 0) {
    expiryStatus = 'expired';
  } else if (daysUntilExpiry <= EXPIRING_SOON_THRESHOLD_DAYS) {
    expiryStatus = 'expiring_soon';
  } else {
    expiryStatus = 'ok';
  }

  return { daysUntilExpiry, expiryStatus };
}

/**
 * Metadata-only view of a document for list responses. encryptedBlob, iv,
 * and authTag never need to leave the server for a list view.
 */
function toListSummary(doc) {
  const { daysUntilExpiry, expiryStatus } = computeExpiryInfo(doc.expiryDate);
  return {
    id: doc._id,
    filename: doc.filename,
    folder: doc.folder,
    expiryDate: doc.expiryDate,
    daysUntilExpiry,
    expiryStatus,
    syncStatus: doc.syncStatus,
    createdAt: doc.createdAt,
  };
}

/**
 * POST /api/documents
 * multipart/form-data with a single file under the "file" field, plus
 * optional `folder` and `expiryDate` fields. The plaintext buffer only
 * ever exists for the duration of this request - only the ciphertext is
 * persisted.
 */
const createDocument = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw badRequest('No file uploaded.');
  }

  const { buffer, originalname, mimetype } = req.file;
  const { folder, expiryDate } = req.body;

  // SHA-256 of the ORIGINAL plaintext. Distinct from the AES-GCM authTag
  // produced below: the authTag proves the ciphertext wasn't tampered
  // with in storage, this checksum proves the decrypted content still
  // matches what was originally uploaded - useful once sync/backup starts
  // copying files around.
  const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

  const { ciphertext, iv, authTag } = encryptFile(buffer, req.session.encryptionKey);

  const document = await Document.create({
    filename: originalname,
    folder: folder || undefined, // let the schema default ("root") apply
    encryptedBlob: Buffer.from(ciphertext, 'base64'),
    iv,
    authTag,
    checksum,
    mimeType: mimetype,
    originDevice: 'pc', // phone client is future work
    expiryDate: expiryDate || undefined,
    syncStatus: 'pending',
  });

  res.status(201).json({
    id: document._id,
    filename: document.filename,
    folder: document.folder,
    expiryDate: document.expiryDate,
    createdAt: document.createdAt,
  });
});

/**
 * GET /api/documents
 */
const listDocuments = asyncHandler(async (req, res) => {
  const documents = await Document.find().sort({ createdAt: -1 });
  res.status(200).json(documents.map(toListSummary));
});

const URGENT_EXPIRY_STATUSES = new Set(['expired', 'expiring_soon']);

/**
 * GET /api/documents/expiring
 * Same shape as the list endpoint, filtered to documents that actually
 * need attention and sorted soonest-first (most overdue first, since a
 * negative daysUntilExpiry sorts before a small positive one). This is
 * what a future reminders view/dashboard widget reads from instead of
 * re-deriving urgency from the full list itself.
 */
const listExpiringDocuments = asyncHandler(async (req, res) => {
  // expiryStatus depends on "today", so it can't be computed in the Mongo
  // query itself - fetch candidates that have a date at all, then filter
  // and sort in JS using the same computeExpiryInfo the list endpoint uses.
  const documents = await Document.find({ expiryDate: { $ne: null } });

  const expiring = documents
    .map(toListSummary)
    .filter((doc) => URGENT_EXPIRY_STATUSES.has(doc.expiryStatus))
    .sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);

  res.status(200).json(expiring);
});

/**
 * GET /api/documents/:id/view
 * Decrypts the document and streams it back. Before responding, re-hashes
 * the decrypted plaintext and compares it against the stored checksum -
 * a mismatch means the data is corrupted independent of whether the
 * AES-GCM authTag itself checked out, so it's a hard failure rather than
 * served anyway.
 */
const viewDocument = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);

  const document = await Document.findById(req.params.id);
  if (!document) {
    throw documentNotFound();
  }

  const plaintext = decryptFile(
    document.encryptedBlob.toString('base64'),
    req.session.encryptionKey,
    document.iv,
    document.authTag
  );

  const actualChecksum = crypto.createHash('sha256').update(plaintext).digest('hex');
  // This is an integrity check, not an authentication check, so a plain
  // equality comparison is fine - there's no secret here to protect from
  // a timing attack (contrast with verifyPassword in utils/crypto.js).
  if (actualChecksum !== document.checksum) {
    const error = new Error('Integrity check failed: this document may be corrupted.');
    error.status = 500;
    throw error;
  }

  res.setHeader('Content-Type', document.mimeType || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${encodeURIComponent(document.filename)}"`
  );
  res.status(200).send(plaintext);
});

/**
 * DELETE /api/documents/:id
 */
const deleteDocument = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);

  const document = await Document.findByIdAndDelete(req.params.id);
  if (!document) {
    throw documentNotFound();
  }

  res.status(204).send();
});

module.exports = {
  createDocument,
  listDocuments,
  listExpiringDocuments,
  viewDocument,
  deleteDocument,
};
