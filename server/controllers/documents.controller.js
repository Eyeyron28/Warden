const crypto = require('crypto');
const mongoose = require('mongoose');

const Document = require('../models/Document');
const Folder = require('../models/Folder');
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
const FOLDER_ROOT = 'root';

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

  // Multipart fields are parsed by multer, which (via bracket syntax like
  // folder[$ne]=x) can hand back objects instead of strings.
  if (folder !== undefined && typeof folder !== 'string') {
    throw badRequest('folder must be a string.');
  }
  if (expiryDate !== undefined && typeof expiryDate !== 'string') {
    throw badRequest('expiryDate must be a string.');
  }

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
 * GET /api/documents/folders
 * Distinct folder names currently in use across all documents, PLUS any
 * empty folders created via POST /api/documents/folders (the Folder
 * collection - see models/Folder.js) that don't have a document in them
 * yet, plus "root" even if nothing is explicitly filed there - every
 * uncategorized document already defaults to "root" via the schema, so
 * the frontend can always offer it as a destination even in a freshly-
 * emptied vault. "root" is sorted first since it's the default/catch-all
 * rather than a folder the owner named; everything else is alphabetical.
 */
const listFolders = asyncHandler(async (req, res) => {
  const [documentFolders, emptyFolders] = await Promise.all([
    Document.distinct('folder'),
    Folder.distinct('name'),
  ]);
  const folderSet = new Set([...documentFolders, ...emptyFolders].filter(Boolean));
  folderSet.add(FOLDER_ROOT);

  const sorted = [...folderSet].sort((a, b) => {
    if (a === FOLDER_ROOT) return -1;
    if (b === FOLDER_ROOT) return 1;
    return a.localeCompare(b);
  });

  res.status(200).json(sorted);
});

/**
 * POST /api/documents/folders
 * Body: { name }
 * Creates an empty folder - "New folder" from the frontend's "+ New"
 * menu. Nothing references this record directly; it exists purely so
 * GET /api/documents/folders can list a folder that has zero documents
 * in it yet (see models/Folder.js). Filing a document into this name
 * later works exactly like filing one into any other folder string -
 * Document.folder doesn't know or care whether a Folder record exists.
 *
 * Idempotent-ish: creating a folder that already has documents in it (or
 * an empty Folder record with the same name) is treated as success
 * rather than a conflict - the caller asked for a folder with this name
 * to exist, and after this request, it does.
 */
const createFolder = asyncHandler(async (req, res) => {
  const { name } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    throw badRequest('A folder name is required.');
  }

  const trimmed = name.trim();
  if (trimmed === FOLDER_ROOT) {
    throw badRequest('"root" is reserved for uncategorized documents.');
  }

  const alreadyHasDocuments = await Document.exists({ folder: trimmed });
  if (!alreadyHasDocuments) {
    // upsert rather than a plain create: a second "create this folder"
    // call for a name that already exists as an empty Folder record
    // should succeed quietly, not throw a duplicate-key error.
    await Folder.updateOne({ name: trimmed }, { $setOnInsert: { name: trimmed } }, { upsert: true });
  }

  res.status(201).json({ name: trimmed });
});

/**
 * DELETE /api/documents/folders?path=<folder path>
 * Removes the empty-folder records (models/Folder.js) for this folder and
 * everything nested under it, so a folder deleted from the UI stops showing
 * up as an empty tile. Deliberately does NOT touch documents - the client
 * deletes those through the ordinary per-document delete first; this only
 * cleans up the folder markers. Idempotent.
 */
const deleteFolder = asyncHandler(async (req, res) => {
  const { path: folderPath } = req.query;

  if (!folderPath || typeof folderPath !== 'string' || !folderPath.trim()) {
    throw badRequest('A folder path is required.');
  }
  const trimmed = folderPath.trim();
  if (trimmed === FOLDER_ROOT) {
    throw badRequest('"root" cannot be deleted.');
  }

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await Folder.deleteMany({ $or: [{ name: trimmed }, { name: { $regex: `^${escaped}/` } }] });

  res.status(204).send();
});

/**
 * PATCH /api/documents/:id
 * Body: any subset of { filename, folder, expiryDate }
 *
 * Metadata-only editing - deliberately does NOT touch encryptedBlob, iv,
 * authTag, or checksum, and never decrypts anything. Renaming a document
 * or moving it to a different folder is just changing how it's labeled;
 * none of those labels are inputs to the encryption, so the vault
 * doesn't need to do anything with the actual encrypted bytes to change
 * them. This is also why this route never touches req.session.encryptionKey.
 *
 * Only fields actually present in the body are updated - omitted fields
 * are left exactly as they were, so a caller can rename a document
 * without also having to resend its current folder and expiry date.
 */
const updateDocument = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);

  const document = await Document.findById(req.params.id);
  if (!document) {
    throw documentNotFound();
  }

  const { filename, folder, expiryDate } = req.body;

  if (filename !== undefined) {
    if (typeof filename !== 'string' || !filename.trim()) {
      throw badRequest('filename cannot be empty.');
    }
    document.filename = filename.trim();
  }

  if (folder !== undefined) {
    if (typeof folder !== 'string') {
      throw badRequest('folder must be a string.');
    }
    document.folder = folder.trim() || FOLDER_ROOT;
  }

  if (expiryDate !== undefined) {
    if (expiryDate === null) {
      document.expiryDate = null;
    } else {
      if (typeof expiryDate !== 'string') {
        throw badRequest('expiryDate must be a valid date, or null to clear it.');
      }
      const parsed = new Date(expiryDate);
      if (Number.isNaN(parsed.getTime())) {
        throw badRequest('expiryDate must be a valid date, or null to clear it.');
      }
      document.expiryDate = parsed;
    }
  }

  await document.save();

  // toListSummary recomputes daysUntilExpiry/expiryStatus from
  // document.expiryDate every time it's called, so this reflects
  // whatever expiryDate ends up as above with no separate branch needed
  // for "did expiryDate change".
  res.status(200).json(toListSummary(document));
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
  listFolders,
  createFolder,
  deleteFolder,
  updateDocument,
  viewDocument,
  deleteDocument,
};
