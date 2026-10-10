const crypto = require('crypto');
const mongoose = require('mongoose');

const Document = require('../models/Document');
const { recordEvent } = require('../utils/audit');
const { parseExpiryInput, daysUntil, expiryStatus: docExpiryState } = require('../utils/docExpiry');
const { rearmReminders } = require('../utils/reminderCleanup');
const { documentScope, pathInScope, toVirtual, toReal } = require('../utils/emergency/scope');
const Share = require('../models/Share');
const { getUsage, assertCanStore } = require('../utils/storage');
const { cleanStoredName, downloadName, contentDisposition } = require('../utils/fileNames');
const { encryptFile, decryptFile } = require('../utils/crypto');
const { encryptThumbnail, decryptThumbnail, hasThumbnail, PREVIEW_FAILURE_REASONS } = require('../utils/thumbnails');
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
const { sniffImageType, sniffPreviewKind, IMAGE_TYPES } = require('../utils/sniff');
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
  const daysUntilExpiry = daysUntil(expiryDate);
  const state = docExpiryState(expiryDate);
  return { daysUntilExpiry, expiryStatus: state === 'expired' ? 'expired' : state === 'soon' ? 'expiring_soon' : 'ok' };
}

/**
 * Metadata-only view of a document for list responses. encryptedBlob, iv,
 * and authTag never need to leave the server for a list view.
 */
function toListSummary(doc, sharedIds = null) {
  // The owner's "Expires on" day, stored READABLE by the server so reminders can go out while nobody is signed in.
  // (Documents saved before docExpiresAt existed carry it as expiryDate; both names are the same date.)
  const expiresAt = doc.docExpiresAt ?? doc.expiryDate ?? null;
  const { daysUntilExpiry, expiryStatus } = computeExpiryInfo(expiresAt);
  return {
    id: doc._id,
    filename: doc.filename,
    folder: doc.folder,
    expiryDate: expiresAt,
    docExpiresAt: expiresAt,
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
    // What kind of preview the bytes allow (null until known), and whether one was tried and failed.
    previewKind: doc.previewKind ?? null,
    thumbFailed: Boolean(doc.thumbFailedAt),
    thumbFailReason: doc.thumbFailedAt ? doc.thumbFailReason ?? null : null,
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
  const docExpiresAt = expiryDate ? parseExpiryInput(expiryDate.slice(0, 10)) : null;
  if (expiryDate && !docExpiresAt) {
    throw badRequest('Expires on must be a date like 2027-03-05.');
  }

  // SHA-256 of the ORIGINAL plaintext. Distinct from the AES-GCM authTag
  // produced below: the authTag proves the ciphertext wasn't tampered
  // with in storage, this checksum proves the decrypted content still
  // matches what was originally uploaded - useful once sync/backup starts
  // copying files around.
  // Refused before anything is encrypted or stored if it would pass the account's quota.
  await assertCanStore(req.userId, buffer.length + (req.files?.thumb?.[0]?.buffer?.length ?? 0));

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
    filename: cleanStoredName(originalname),
    folder: toDocumentFolder(canonicalFolder),
    encryptedBlob: Buffer.from(ciphertext, 'base64'),
    iv,
    authTag,
    checksum,
    mimeType: mimetype,
    // Classified from the bytes, not the name or the claimed type.
    sniffedType: sniffImageType(buffer),
    previewKind: sniffPreviewKind(buffer),
    originDevice: 'pc', // phone client is future work
    docExpiresAt,
    syncStatus: 'pending',
    ...(thumbnail || {}),
  });

  await recordEvent(req, 'upload', { targetId: document._id });
  res.status(201).json({
    id: document._id,
    filename: document.filename,
    folder: document.folder,
    expiryDate: document.docExpiresAt,
    docExpiresAt: document.docExpiresAt,
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
  docExpiresAt: 1,
  syncStatus: 1,
  thumbMime: 1,
  createdAt: 1,
  updatedAt: 1,
  mimeType: 1,
  sniffedType: 1,
  previewKind: 1,
  thumbFailedAt: 1,
  thumbFailReason: 1,
  size: { $binarySize: '$encryptedBlob' },
};

const listDocuments = asyncHandler(async (req, res) => {
  // Anything past its Trash retention is removed on the account's own requests.
  await purgeExpired(req.userId);
  // The blobs are never part of a list response (the size is computed inside
  // MongoDB), and trashed documents are not part of the vault.
  const documents = await Document.aggregate([
    { $match: { userId: req.userId, deletedAt: null, ...documentScope(req.emergency) } },
    { $sort: { createdAt: -1 } },
    { $project: LIST_PROJECTION },
  ]);
  if (req.emergency) {
    // A contact sees paths that start at the scope folder (never the names above it) and no sharing information.
    return res.status(200).json(
      documents.map((doc) => {
        const summary = toListSummary(doc, null);
        return { ...summary, folder: toVirtual(req.emergency, summary.folder) };
      })
    );
  }
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
  // The same service the quota check uses, so the meter and the limit never disagree.
  res.status(200).json(await getUsage(req.userId));
});

/**
 * GET /api/documents/folders/children?path=
 * The folders directly inside one folder ("" = top level), for the sidebar's
 * lazily loaded tree. `hasChildren` says whether a folder can be expanded.
 */
const listFolderChildren = asyncHandler(async (req, res) => {
  const asked = typeof req.query.path === 'string' ? req.query.path : '';
  // An emergency session names folders from its own scope root; translate to the real path (null = not in scope).
  const requested = toReal(req.emergency, asked);
  if (requested === null) throw httpError(404, 'Folder not found.');
  const canonical = await resolveFolderPath(req.userId, requested);
  if (canonical === null) {
    throw httpError(404, 'Folder not found.');
  }
  if (req.emergency?.scopeMode === 'folders') {
    // An emergency session sees only its chosen folders, listed at the top level (the folders above them are
    // not listed or openable), and what is inside them.
    if (canonical === '') {
      const scoped = req.emergency.scopePaths || [];
      const withKids = new Set(scoped.length ? await Folder.distinct('parentPath', { userId: req.userId, parentPath: { $in: scoped } }) : []);
      const top = scoped
        .map((path) => ({ path, hasChildren: withKids.has(path) }))
        .map(({ path, hasChildren }) => ({ name: toVirtual(req.emergency, path), path: toVirtual(req.emergency, path), hasChildren }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return res.status(200).json({ path: '', folders: top });
    }
    if (!pathInScope(req.emergency, canonical)) throw httpError(404, 'Folder not found.');
  }
  const children = await Folder.find({ userId: req.userId, parentPath: canonical }).select('name parentPath');
  const paths = children.map((folder) => joinPath(canonical, folder.name));
  const withChildren = new Set(
    paths.length ? await Folder.distinct('parentPath', { userId: req.userId, parentPath: { $in: paths } }) : []
  );
  const folders = children
    .map((folder, index) => ({ name: folder.name, path: toVirtual(req.emergency, paths[index]), hasChildren: withChildren.has(paths[index]) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.status(200).json({ path: toVirtual(req.emergency, canonical), folders });
});


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
  const documents = await Document.find({ userId: req.userId, deletedAt: null, docExpiresAt: { $ne: null } });

  // Files with an "Expires on" day that is within 60 days or already past, soonest (most overdue) first.
  const expiring = documents
    .map((doc) => toListSummary(doc))
    .filter((doc) => doc.expiryStatus === 'expired' || doc.expiryStatus === 'expiring_soon')
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
  const paths = (await listFolderPaths(req.userId)).filter((path) => pathInScope(req.emergency, path)).map((path) => toVirtual(req.emergency, path));
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
  await recordEvent(req, 'rename');
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
  await recordEvent(req, 'delete');
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

  for (const result of results) {
    if (result.status === 'moved') {
      // eslint-disable-next-line no-await-in-loop
      await recordEvent(req, 'move', { targetId: result.type === 'file' ? result.id : null });
    }
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

  const { filename, folder, expiryDate, docExpiresAt } = req.body;
  let renamed = false;
  let expiryEvent = null;

  if (filename !== undefined) {
    if (typeof filename !== 'string' || !filename.trim()) {
      throw badRequest('filename cannot be empty.');
    }
    document.filename = cleanStoredName(filename);
    renamed = true;
  }

  // Changing a document's folder only happens through POST
  // /api/documents/move, which enforces the folder rules and name-conflict
  // checks - never as a side effect of a metadata edit.
  if (folder !== undefined) {
    throw badRequest('Use Move to change which folder a document is in.');
  }

  // docExpiresAt, or its older name expiryDate: the same single date.
  const incoming = docExpiresAt !== undefined ? docExpiresAt : expiryDate;
  if (incoming !== undefined) {
    let next = null;
    if (incoming !== null) {
      // A date-only string; an ISO timestamp from an older client is cut to its day.
      next = typeof incoming === 'string' ? parseExpiryInput(incoming.slice(0, 10)) : null;
      if (!next) throw badRequest('Expires on must be a date like 2027-03-05, or null to clear it.');
    }
    const before = (document.docExpiresAt ?? document.expiryDate) ? new Date(document.docExpiresAt ?? document.expiryDate).getTime() : null;
    const after = next ? next.getTime() : null;
    if (before !== after) {
      document.docExpiresAt = next;
      document.expiryDate = undefined;
      expiryEvent = next ? 'expiry_set' : 'expiry_cleared';
    }
  }

  await document.save();
  if (renamed) await recordEvent(req, 'rename', { targetId: document._id });
  if (expiryEvent) {
    // A new date starts the reminders over: every threshold may fire again for it.
    await rearmReminders(req.userId, document._id);
    await recordEvent(req, expiryEvent, { targetId: document._id });
  }

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

  // An emergency session can only reach files inside its scope; anything else is the same 404 as a missing file.
  const document = await Document.findOne({ _id: req.params.id, userId: req.userId, deletedAt: null, ...documentScope(req.emergency) });
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
    error.expose = true; // app-authored message, written for the user
    throw error;
  }

  // The decrypted bytes go back as OPAQUE data: never the type the uploader
  // claimed, never inline. The browser decides what the file is by sniffing the
  // bytes themselves (client/src/utils/previewType.js) and builds its own Blob.
  // What this request is for decides what it counts as. The browser says so with ?for=: "download" (the
  // Download button), "silent" (an export, or drawing a preview: neither is the person opening the file),
  // and anything else is a view. Counters live on the document; the activity log gets one event.
  const purpose = req.query.for === 'download' || req.query.for === 'silent' ? req.query.for : 'view';
  if (req.emergency) {
    // Emergency access never touches the owner's counters, and EVERY read is logged (even ?for=silent): the
    // activity log is how the owner learns what was looked at. The event holds the file id only.
    await recordEvent(req, purpose === 'download' ? 'emergency_file_downloaded' : 'emergency_file_viewed', {
      targetId: document._id,
      deviceId: null,
      actor: 'emergency',
    });
  } else if (purpose !== 'silent') {
    await Document.updateOne(
      { _id: document._id, userId: req.userId },
      { $set: { lastOpenedAt: new Date() }, $inc: purpose === 'download' ? { downloadCount: 1 } : { viewCount: 1 } },
      { timestamps: false }
    );
    await recordEvent(req, purpose, { targetId: document._id });
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  // The stored name is never changed; the DOWNLOAD name is sanitised and, for a name with no
  // extension whose bytes are a known type, gains that type's extension (utils/fileNames.js).
  res.setHeader('Content-Disposition', contentDisposition(downloadName(document.filename, plaintext)));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(plaintext);
});

/**
 * POST /api/documents/:id/downloaded
 * The preview already holds the decrypted file, so its Download button saves it without asking the server
 * for the bytes again. This records that it happened (the counter and one `download` event). Another
 * account's id, a trashed file and an unknown id are all the same 404.
 */
const recordDownload = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);
  const document = await Document.findOne({ _id: req.params.id, userId: req.userId, deletedAt: null }).select('_id');
  if (!document) throw documentNotFound();
  await Document.updateOne(
    { _id: document._id, userId: req.userId },
    { $set: { lastOpenedAt: new Date() }, $inc: { downloadCount: 1 } },
    { timestamps: false }
  );
  await recordEvent(req, 'download', { targetId: document._id });
  res.status(204).send();
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

  const document = await Document.findOne({ _id: req.params.id, userId: req.userId, deletedAt: null, ...documentScope(req.emergency) });
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
  // A preview now exists: forget any earlier failure.
  document.thumbFailedAt = null;
  document.thumbFailReason = null;
  if (!document.previewKind || document.previewKind === 'none') document.previewKind = 'image';
  await document.save();

  res.status(200).json({ id: document._id, hasThumb: true });
});

/**
 * POST /api/documents/:id/thumbnail-failed
 * Body: { reason, kind? } - the browser tried to draw a preview and could not (or saw
 * the file is not one it may draw). Recorded so the file is not retried on every run.
 * `reason` must be one of PREVIEW_FAILURE_REASONS; `kind` ('image' | 'pdf' | 'none') is what
 * the browser's own byte-sniff said, and lets the list stop counting the file.
 */
const markThumbnailFailed = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);
  const { reason, kind } = req.body || {};
  if (typeof reason !== 'string' || !PREVIEW_FAILURE_REASONS.includes(reason)) {
    throw badRequest('Unknown reason.');
  }
  const set = { thumbFailedAt: new Date(), thumbFailReason: reason };
  if (kind === 'image' || kind === 'pdf' || kind === 'none') set.previewKind = kind;
  if (reason === 'unsupported-type') set.previewKind = 'none';
  const result = await Document.updateOne({ _id: req.params.id, userId: req.userId, deletedAt: null }, { $set: set }, { timestamps: false });
  if (!result.matchedCount) throw documentNotFound();
  res.status(200).json({ id: req.params.id, thumbFailed: true, thumbFailReason: set.thumbFailReason });
});

/**
 * POST /api/documents/thumbnails/retry
 * Forgets recorded preview failures for this account (so "Try again" really tries again).
 */
const retryFailedThumbnails = asyncHandler(async (req, res) => {
  const result = await Document.updateMany(
    { userId: req.userId, deletedAt: null, thumbFailedAt: { $ne: null } },
    { $set: { thumbFailedAt: null, thumbFailReason: null } },
    { timestamps: false }
  );
  res.status(200).json({ cleared: result.modifiedCount ?? result.matchedCount ?? 0 });
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

  await recordEvent(req, 'delete', { targetId: req.params.id });
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
  recordDownload,
  getThumbnail,
  putThumbnail,
  markThumbnailFailed,
  retryFailedThumbnails,
  deleteDocument,
  listPhotos,
  getStorage,
  listFolderChildren,
};
