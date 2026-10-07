const crypto = require('crypto');
const mongoose = require('mongoose');

const Document = require('../models/Document');
const Share = require('../models/Share');
const { encryptFile, decryptFile } = require('../utils/crypto');
const { encryptThumbnail, decryptThumbnail, hasThumbnail } = require('../utils/thumbnails');
const {
  httpError,
  parentOf,
  joinPath,
  lastSegment,
  toDocumentFolder,
  normalizeDocumentFolder,
  isSameOrDescendant,
  validateFolderName,
  resolveFolderPath,
  ensureFolderPath,
  createFolderExplicit,
  moveFolder,
  runInTransaction,
  listFolderPaths,
  deleteFolderTree,
} = require('../utils/folders');
const { sniffImageType, IMAGE_TYPES } = require('../utils/sniff');
const { trashDocument, trashFolder, purgeExpired } = require('../utils/trash');
const Folder = require('../models/Folder');

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
function toListSummary(doc, sharedIds = null) {
  const { daysUntilExpiry, expiryStatus } = computeExpiryInfo(doc.expiryDate);
  return {
    id: doc._id,
    filename: doc.filename,
    folder: doc.folder,
    expiryDate: doc.expiryDate,
    daysUntilExpiry,
    expiryStatus,
    syncStatus: doc.syncStatus,
    // Only a flag: thumbnails are never embedded in list responses (they
    // would bloat every call) - the client fetches each one on demand from
    // GET /api/documents/:id/thumbnail.
    hasThumb: hasThumbnail(doc),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    // The file's size in bytes (AES-GCM ciphertext is exactly as long as the plaintext).
    size: doc.size ?? (Buffer.isBuffer(doc.encryptedBlob) ? doc.encryptedBlob.length : null),
    // What the bytes say (null until classified). The declared type is the client's claim only.
    sniffedType: doc.sniffedType ?? null,
    mimeType: doc.mimeType,
    // Whether the file is in a link that is still active (for the list's shared indicator).
    shared: sharedIds ? sharedIds.has(String(doc._id)) : false,
  };
}

/** Ids of this account's documents that are in an active share link. */
async function activeSharedIds(userId) {
  const ids = await Share.distinct('sourceDocumentIds', { ownerUserId: userId, expiresAt: { $gt: new Date() } });
  return new Set(ids.map(String));
}

/**
 * POST /api/documents
 * multipart/form-data with a single file under the "file" field, plus
 * optional `folder` and `expiryDate` fields. The plaintext buffer only
 * ever exists for the duration of this request - only the ciphertext is
 * persisted.
 */
const createDocument = asyncHandler(async (req, res) => {
  const uploadedFile = req.files?.file?.[0];
  if (!uploadedFile) {
    throw badRequest('No file uploaded.');
  }

  const { buffer, originalname, mimetype } = uploadedFile;
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

  const { ciphertext, iv, authTag } = encryptFile(buffer, req.dek);

  // Optional preview the browser drew from the plaintext. An invalid or
  // oversized one is simply dropped - it must never fail the upload.
  const thumbUpload = req.files?.thumb?.[0];
  const thumbnail = thumbUpload ? encryptThumbnail(thumbUpload.buffer, thumbUpload.mimetype, req.dek) : null;

  // Implicit folder creation: "josh/2024" files into an existing
  // "Josh/2024" rather than creating a second, differently-cased folder
  // (see utils/folders.js ensureFolderPath). Never errors on a collision.
  const canonicalFolder = await ensureFolderPath(req.userId, folder || '');

  const document = await Document.create({
    userId: req.userId,
    filename: originalname,
    folder: toDocumentFolder(canonicalFolder),
    encryptedBlob: Buffer.from(ciphertext, 'base64'),
    iv,
    authTag,
    checksum,
    mimeType: mimetype,
    // Classified from the bytes, not the name or the claimed type.
    sniffedType: sniffImageType(buffer),
    originDevice: 'pc', // phone client is future work
    expiryDate: expiryDate || undefined,
    syncStatus: 'pending',
    ...(thumbnail || {}),
  });

  res.status(201).json({
    id: document._id,
    filename: document.filename,
    folder: document.folder,
    expiryDate: document.expiryDate,
    hasThumb: hasThumbnail(document),
    createdAt: document.createdAt,
  });
});

/**
 * GET /api/documents
 */
const LIST_PROJECTION = {
  filename: 1,
  folder: 1,
  expiryDate: 1,
  syncStatus: 1,
  thumbMime: 1,
  createdAt: 1,
  updatedAt: 1,
  mimeType: 1,
  sniffedType: 1,
  size: { $binarySize: '$encryptedBlob' },
};

const listDocuments = asyncHandler(async (req, res) => {
  // Anything past its Trash retention is removed on the account's own requests.
  await purgeExpired(req.userId);
  // The blobs are never part of a list response (the size is computed inside
  // MongoDB), and trashed documents are not part of the vault.
  const documents = await Document.aggregate([
    { $match: { userId: req.userId, deletedAt: null } },
    { $sort: { createdAt: -1 } },
    { $project: LIST_PROJECTION },
  ]);
  const sharedIds = await activeSharedIds(req.userId);
  res.status(200).json(documents.map((doc) => toListSummary(doc, sharedIds)));
});

const SNIFF_BATCH = 12;

/**
 * GET /api/documents/photos
 * Every image in the vault (all folders), newest first - decided by SNIFFING
 * the bytes (utils/sniff.js), never by the name or the type claimed at upload.
 * Files uploaded before sniffing existed are classified here, a few per request
 * (decrypting for this signed-in session and storing only the resulting type);
 * `pending` says how many are still waiting, so the client asks again.
 */
const listPhotos = asyncHandler(async (req, res) => {
  await purgeExpired(req.userId);

  const unclassified = await Document.find({ userId: req.userId, deletedAt: null, sniffedType: null })
    .select('_id encryptedBlob iv authTag')
    .limit(SNIFF_BATCH);
  for (const doc of unclassified) {
    let type = 'none';
    try {
      const plaintext = decryptFile(doc.encryptedBlob.toString('base64'), req.dek, doc.iv, doc.authTag);
      type = sniffImageType(plaintext);
    } catch {
      // A file that will not decrypt is simply not a photo.
    }
    // eslint-disable-next-line no-await-in-loop
    await Document.updateOne({ _id: doc._id }, { $set: { sniffedType: type } }, { timestamps: false });
  }

  const [photos, pending] = await Promise.all([
    Document.aggregate([
      { $match: { userId: req.userId, deletedAt: null, sniffedType: { $in: IMAGE_TYPES } } },
      { $sort: { createdAt: -1 } },
      { $project: LIST_PROJECTION },
    ]),
    Document.countDocuments({ userId: req.userId, deletedAt: null, sniffedType: null }),
  ]);
  const sharedIds = await activeSharedIds(req.userId);
  res.status(200).json({ photos: photos.map((doc) => toListSummary(doc, sharedIds)), pending });
});

/**
 * GET /api/documents/storage
 * What this account stores: the vault, and what is waiting in Trash.
 */
const getStorage = asyncHandler(async (req, res) => {
  const rows = await Document.aggregate([
    { $match: { userId: req.userId } },
    {
      $group: {
        _id: { $ne: ['$deletedAt', null] },
        bytes: { $sum: { $binarySize: '$encryptedBlob' } },
        count: { $sum: 1 },
      },
    },
  ]);
  const live = rows.find((row) => row._id === false);
  const trashed = rows.find((row) => row._id === true);
  res.status(200).json({
    fileBytes: live?.bytes ?? 0,
    fileCount: live?.count ?? 0,
    trashBytes: trashed?.bytes ?? 0,
    trashCount: trashed?.count ?? 0,
  });
});

/**
 * GET /api/documents/folders/children?path=
 * The folders directly inside one folder ("" = top level), for the sidebar's
 * lazily loaded tree. `hasChildren` says whether a folder can be expanded.
 */
const listFolderChildren = asyncHandler(async (req, res) => {
  const requested = typeof req.query.path === 'string' ? req.query.path : '';
  const canonical = await resolveFolderPath(req.userId, requested);
  if (canonical === null) {
    throw httpError(404, 'Folder not found.');
  }
  const children = await Folder.find({ userId: req.userId, parentPath: canonical }).select('name parentPath');
  const paths = children.map((folder) => joinPath(canonical, folder.name));
  const withChildren = new Set(
    paths.length ? await Folder.distinct('parentPath', { userId: req.userId, parentPath: { $in: paths } }) : []
  );
  const folders = children
    .map((folder, index) => ({ name: folder.name, path: paths[index], hasChildren: withChildren.has(paths[index]) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.status(200).json({ path: canonical, folders });
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
  const documents = await Document.find({ userId: req.userId, deletedAt: null, expiryDate: { $ne: null } });

  const expiring = documents
    .map((doc) => toListSummary(doc))
    .filter((doc) => URGENT_EXPIRY_STATUSES.has(doc.expiryStatus))
    .sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);

  res.status(200).json(expiring);
});

/**
 * GET /api/documents/folders
 * Every folder path in the account (canonical spelling - see
 * models/Folder.js), plus "root" even if nothing is explicitly filed there,
 * so the frontend can always offer the top level. "root" is sorted first;
 * everything else is alphabetical.
 */
const listFolders = asyncHandler(async (req, res) => {
  const paths = await listFolderPaths(req.userId);
  const sorted = paths.sort((a, b) => a.localeCompare(b));
  res.status(200).json([FOLDER_ROOT, ...sorted]);
});

/**
 * POST /api/documents/folders
 * Body: { name } - the new folder's full path, e.g. "Taxes/2024" for a
 * "2024" folder created while viewing "Taxes" (what the New folder dialog
 * sends). Optionally { parentPath, name } instead.
 *
 * Explicit creation, so unlike every implicit path (uploads, sync) a name
 * that already exists in that parent - compared trimmed and
 * case-insensitively - is a 409 with code FOLDER_EXISTS, not a silent
 * success. The parent folders themselves resolve/create implicitly.
 */
const createFolder = asyncHandler(async (req, res) => {
  const { name, parentPath } = req.body;

  if (typeof name !== 'string' || (parentPath !== undefined && typeof parentPath !== 'string')) {
    throw badRequest('A folder name is required.');
  }

  let parent;
  let leaf;
  if (parentPath !== undefined) {
    parent = parentPath;
    leaf = name;
  } else {
    // Full-path form: everything before the last "/" is the parent. A
    // "\" in the leaf is rejected by validateFolderName.
    const lastSlash = name.lastIndexOf('/');
    parent = lastSlash === -1 ? '' : name.slice(0, lastSlash);
    leaf = lastSlash === -1 ? name : name.slice(lastSlash + 1);
  }

  const created = await createFolderExplicit(req.userId, parent, leaf);
  res.status(201).json({ name: created });
});

/**
 * PATCH /api/documents/folders
 * Body: { path, name }
 * Renames a folder in place. Same validation and uniqueness rule as
 * creation (409 FOLDER_EXISTS on a clash with a sibling), and the same
 * transactional prefix rewrite as Move, so every nested folder and
 * document follows the new name.
 */
const renameFolder = asyncHandler(async (req, res) => {
  const { path: folderPath, name } = req.body;
  if (typeof folderPath !== 'string' || !folderPath.trim()) {
    throw badRequest('A folder path is required.');
  }

  const srcPath = await resolveFolderPath(req.userId, folderPath);
  if (!srcPath) throw httpError(404, 'Folder not found.');

  const parent = parentOf(srcPath);
  const newName = validateFolderName(name, { atRoot: !parent });

  const { newPath } = await runInTransaction((session) =>
    moveFolder(req.userId, srcPath, parent, newName, session)
  );
  res.status(200).json({ path: newPath });
});

/**
 * DELETE /api/documents/folders?path=<folder path>
 * Removes this folder's record and every nested folder record. Documents
 * are deleted by the client first, one by one; anything still filed under
 * the path keeps its folders (see utils/folders.js deleteFolderTree).
 * Idempotent.
 */
const deleteFolder = asyncHandler(async (req, res) => {
  const { path: folderPath } = req.query;

  if (!folderPath || typeof folderPath !== 'string' || !folderPath.trim()) {
    throw badRequest('A folder path is required.');
  }
  if (folderPath.trim() === FOLDER_ROOT) {
    throw badRequest('"root" cannot be deleted.');
  }

  // Moves the folder and everything in it to Trash as one entry (restorable for
  // 30 days). A folder that is not there is a success: this is idempotent.
  await trashFolder(req.userId, folderPath.trim());
  res.status(204).send();
});

const MAX_MOVE_ITEMS = 500;

/**
 * POST /api/documents/move
 * Body: { items: [{ type: 'file', id } | { type: 'folder', path }], destination }
 * `destination` is a folder path, "" for the top level.
 *
 * Moves each item independently and reports per item:
 *   { ..., status: 'moved' | 'unchanged' | 'conflict' | 'invalid' | 'not_found', message? }
 * A conflict (an item with the same name already in the destination) is
 * never overwritten - it's reported and the rest still move. Folders are
 * referenced by path because that's how the client's tree identifies them
 * (folders have no client-facing ids); both are resolved within this
 * account only, so another account's items are simply "not_found".
 *
 * Each folder move is its own transaction (see utils/folders.js
 * moveFolder): the folder, its subfolders and everything inside move
 * together or not at all.
 */
const moveItems = asyncHandler(async (req, res) => {
  const { items, destination } = req.body;

  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_MOVE_ITEMS) {
    throw badRequest(`items must be a list of 1 to ${MAX_MOVE_ITEMS} files or folders.`);
  }
  if (typeof destination !== 'string') {
    throw badRequest('destination must be a folder path ("" for the top level).');
  }
  for (const item of items) {
    const validFile = item?.type === 'file' && typeof item.id === 'string';
    const validFolder = item?.type === 'folder' && typeof item.path === 'string';
    if (!validFile && !validFolder) {
      throw badRequest('Each item must be { type: "file", id } or { type: "folder", path }.');
    }
  }

  const destPath = await resolveFolderPath(req.userId, destination);
  if (destPath === null) {
    throw httpError(404, 'Destination folder not found.');
  }


  const results = new Array(items.length);
  const describe = (item) =>
    item.type === 'file' ? { type: 'file', id: item.id } : { type: 'folder', path: item.path };

  // Snapshot everything up front, before anything moves: each selected
  // folder's canonical path, and each selected file's ORIGINAL folder - a
  // file (or subfolder) that sits inside another selected folder moves
  // along with that folder rather than being pulled out of it into the
  // destination, and whether it "moved" depends on whether that folder did.
  const folderPaths = new Map(); // item index -> canonical path (or null)
  const documents = new Map(); // item index -> document (or null)
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.type === 'folder') {
      // eslint-disable-next-line no-await-in-loop
      folderPaths.set(index, await resolveFolderPath(req.userId, item.path));
    } else {
      documents.set(
        index,
        mongoose.Types.ObjectId.isValid(item.id)
          ? // eslint-disable-next-line no-await-in-loop
            await Document.findOne({ _id: item.id, userId: req.userId, deletedAt: null })
          : null
      );
    }
  }
  const selected = [...folderPaths.values()].filter(Boolean);
  const enclosingSelected = (path, self) =>
    selected.find((folder) => folder !== self && isSameOrDescendant(path, folder));

  const errorStatus = (err) =>
    ({ 409: 'conflict', 404: 'not_found', 400: 'invalid' })[err.status] || null;

  // 1. Folders that aren't inside another selected folder.
  const movedFolders = new Set();
  for (const [index, srcPath] of folderPaths) {
    const base = describe(items[index]);
    if (!srcPath) {
      results[index] = { ...base, status: 'not_found', message: 'Folder not found.' };
      continue;
    }
    if (enclosingSelected(srcPath, srcPath)) continue; // handled in step 2
    const name = lastSegment(srcPath);
    if (parentOf(srcPath) === destPath) {
      results[index] = { ...base, name, status: 'unchanged', message: 'Already in this folder.' };
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const { newPath } = await runInTransaction((session) =>
        moveFolder(req.userId, srcPath, destPath, name, session)
      );
      movedFolders.add(srcPath);
      results[index] = { ...base, name, status: 'moved', newPath };
    } catch (err) {
      const status = errorStatus(err);
      if (!status) throw err;
      results[index] = { ...base, name, status, message: err.message };
    }
  }

  const alongWith = (path, self) => {
    const enclosing = enclosingSelected(path, self);
    if (!enclosing) return null;
    return movedFolders.has(enclosing)
      ? { status: 'moved', message: `Moved along with "${lastSegment(enclosing)}".` }
      : { status: 'invalid', message: `Not moved - its folder "${lastSegment(enclosing)}" couldn't be moved.` };
  };

  // 2. Folders nested inside another selected folder.
  for (const [index, srcPath] of folderPaths) {
    if (!srcPath || results[index]) continue;
    results[index] = { ...describe(items[index]), name: lastSegment(srcPath), ...alongWith(srcPath, srcPath) };
  }

  // 3. Files.
  for (const [index, document] of documents) {
    const base = describe(items[index]);
    if (!document) {
      results[index] = { ...base, status: 'not_found', message: 'File not found.' };
      continue;
    }
    const name = document.filename;
    const original = normalizeDocumentFolder(document.folder);
    const along = alongWith(original, null);
    if (along) {
      results[index] = { ...base, name, ...along };
      continue;
    }
    if (original === destPath) {
      results[index] = { ...base, name, status: 'unchanged', message: 'Already in this folder.' };
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const clash = await Document.exists({
      userId: req.userId,
      deletedAt: null,
      folder: toDocumentFolder(destPath),
      filename: name,
      _id: { $ne: document._id },
    });
    if (clash) {
      results[index] = { ...base, name, status: 'conflict', message: `A file named "${name}" is already there.` };
      continue;
    }
    document.folder = toDocumentFolder(destPath);
    // eslint-disable-next-line no-await-in-loop
    await document.save(); // bumps updatedAt (timestamps) for phone sync
    results[index] = { ...base, name, status: 'moved' };
  }

  res.status(200).json({
    destination: destPath,
    movedCount: results.filter((result) => result.status === 'moved').length,
    results,
  });
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

  const document = await Document.findOne({ _id: req.params.id, userId: req.userId, deletedAt: null });
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

  // Changing a document's folder only happens through POST
  // /api/documents/move, which enforces the folder rules and name-conflict
  // checks - never as a side effect of a metadata edit.
  if (folder !== undefined) {
    throw badRequest('Use Move to change which folder a document is in.');
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

  const document = await Document.findOne({ _id: req.params.id, userId: req.userId, deletedAt: null });
  if (!document) {
    throw documentNotFound();
  }

  const plaintext = decryptFile(
    document.encryptedBlob.toString('base64'),
    req.dek,
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

  // The decrypted bytes go back as OPAQUE data: never the type the uploader
  // claimed, never inline. The browser decides what the file is by sniffing the
  // bytes themselves (client/src/utils/previewType.js) and builds its own Blob.
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(document.filename)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(plaintext);
});

/**
 * GET /api/documents/:id/thumbnail
 * The owner's own preview, decrypted with the session's DEK the same way
 * /view serves the file itself. Scoped by { _id, userId }, so another
 * account's id is a plain 404. Never cached by the browser or any proxy,
 * since it is document content.
 */
const getThumbnail = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);

  const document = await Document.findOne({ _id: req.params.id, userId: req.userId, deletedAt: null });
  if (!document || !hasThumbnail(document)) {
    throw documentNotFound();
  }

  let image;
  try {
    image = decryptThumbnail(document, req.dek);
  } catch {
    // Treated as "no usable thumbnail" so the client falls back to the icon
    // instead of surfacing a 500 for something purely cosmetic.
    throw documentNotFound();
  }

  res.setHeader('Content-Type', document.thumbMime);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).send(image);
});

/**
 * PUT /api/documents/:id/thumbnail
 * multipart with a single "thumb" file. Adds (or replaces) the preview of
 * an existing document - used when the browser has just decrypted that
 * document for viewing and can draw one from it. Same validation and
 * encryption as at upload; touches nothing but the thumbnail fields.
 */
const putThumbnail = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);

  const thumbUpload = req.files?.thumb?.[0];
  if (!thumbUpload) {
    throw badRequest('No thumbnail uploaded.');
  }

  const document = await Document.findOne({ _id: req.params.id, userId: req.userId, deletedAt: null });
  if (!document) {
    throw documentNotFound();
  }

  const thumbnail = encryptThumbnail(thumbUpload.buffer, thumbUpload.mimetype, req.dek);
  if (!thumbnail) {
    throw badRequest('Thumbnail must be a WebP or JPEG image of at most 40KB.');
  }

  document.set(thumbnail);
  await document.save();

  res.status(200).json({ id: document._id, hasThumb: true });
});

/**
 * DELETE /api/documents/:id - moves to Trash (see utils/trash.js)
 */
const deleteDocument = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);

  // Moves the file to Trash (still encrypted, restorable for 30 days) and stops
  // any share that includes it. Another account's id is a plain 404.
  const trashed = await trashDocument(req.userId, req.params.id);
  if (!trashed) {
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
  renameFolder,
  deleteFolder,
  moveItems,
  updateDocument,
  viewDocument,
  getThumbnail,
  putThumbnail,
  deleteDocument,
  listPhotos,
  getStorage,
  listFolderChildren,
};
