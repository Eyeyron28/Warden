const crypto = require('crypto');
const mongoose = require('mongoose');

const Document = require('../models/Document');
const { recordEvent } = require('../utils/audit');
const { parseExpiryInput, daysUntil, expiryStatus: docExpiryState } = require('../utils/docExpiry');
const { rearmReminders } = require('../utils/reminderCleanup');
const { documentScope, pathInScope, toVirtual, toReal } = require('../utils/emergency/scope');
const Share = require('../models/Share');
const { getUsage, assertCanStore } = require('../utils/storage');
const { assertRoomForDocument } = require('../utils/uploadLimits');
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
  splitPath,
  resolveFolderPath,
  ensureFolderPath,
  createFolderExplicit,
  moveFolder,
  runInTransaction,
  listFolderPaths,
  deleteFolderTree,
} = require('../utils/folders');
const { sniffImageType, sniffPreviewKind, IMAGE_TYPES } = require('../utils/sniff');
const { NOT_HELD, isHeld, assertNotHeld, safeScan, scanFields, refuse, refuseZip, noteHeld } = require('../utils/quarantine');
const { describeReasons, isPlainZip } = require('../utils/fileScanner');
const { freeName } = require('../utils/uniqueName');
const { trashDocument, trashFolder, purgeExpired } = require('../utils/trash');
const { parseFolderStyle, hasStyleFields } = require('../utils/folderStyle');
const Folder = require('../models/Folder');

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

function computeExpiryInfo(expiryDate) {
  if (!expiryDate) {
    return { daysUntilExpiry: null, expiryStatus: 'ok' };
  }
  const daysUntilExpiry = daysUntil(expiryDate);
  const state = docExpiryState(expiryDate);
  return { daysUntilExpiry, expiryStatus: state === 'expired' ? 'expired' : state === 'soon' ? 'expiring_soon' : 'ok' };
}

function toListSummary(doc, sharedIds = null) {
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
    hasThumb: hasThumbnail(doc),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    size: doc.size ?? (Buffer.isBuffer(doc.encryptedBlob) ? doc.encryptedBlob.length : null),
    sniffedType: doc.sniffedType ?? null,
    previewKind: doc.previewKind ?? null,
    thumbFailed: Boolean(doc.thumbFailedAt),
    thumbFailReason: doc.thumbFailedAt ? doc.thumbFailReason ?? null : null,
    mimeType: doc.mimeType,
    starred: Boolean(doc.starred),
    hasNote: Boolean(doc.hasNote),
    shared: sharedIds ? sharedIds.has(String(doc._id)) : false,
  };
}

async function activeSharedIds(userId) {
  const ids = await Share.distinct('sourceDocumentIds', { ownerUserId: userId, expiresAt: { $gt: new Date() } });
  return new Set(ids.map(String));
}

const UPLOAD_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isDuplicateKey = (error) => error && (error.code === 11000 || /E11000/.test(String(error.message)));

const uploadAnswer = (document, extra = {}) => ({
  id: document._id,
  ...(isHeld(document) ? { held: true, reasons: describeReasons(document.scan?.reasons) } : {}),
  scan: document.scan?.verdict ?? null,
  filename: document.filename,
  folder: document.folder,
  expiryDate: document.docExpiresAt,
  docExpiresAt: document.docExpiresAt,
  hasThumb: hasThumbnail(document),
  createdAt: document.createdAt,
  nameChanged: false,
  ...extra,
});

const findByUploadKey = (userId, uploadKey) =>
  Document.findOne({ userId, uploadKey }).select('filename folder docExpiresAt thumbMime createdAt quarantine scan');

const createDocument = asyncHandler(async (req, res) => {
  const uploadedFile = req.files?.file?.[0];
  if (!uploadedFile) {
    throw badRequest('No file uploaded.');
  }

  const { buffer, originalname, mimetype } = uploadedFile;
  const { folder, expiryDate, uploadKey } = req.body;

  if (folder !== undefined && typeof folder !== 'string') {
    throw badRequest('folder must be a string.');
  }
  if (expiryDate !== undefined && typeof expiryDate !== 'string') {
    throw badRequest('expiryDate must be a string.');
  }
  if (uploadKey !== undefined && (typeof uploadKey !== 'string' || !UPLOAD_KEY.test(uploadKey))) {
    throw badRequest('uploadKey must be a UUID.');
  }
  const docExpiresAt = expiryDate ? parseExpiryInput(expiryDate.slice(0, 10)) : null;
  if (expiryDate && !docExpiresAt) {
    throw badRequest('Expires on must be a date like 2027-03-05.');
  }

  if (isPlainZip(originalname, buffer)) throw await refuseZip(req);
  const scanResult = safeScan({ name: originalname, type: mimetype, buffer });
  if (scanResult.verdict === 'blocked') throw await refuse(req, scanResult);
  const held = scanResult.verdict === 'suspicious';

  const wantedName = cleanStoredName(originalname);
  const quotaOutcome = assertCanStore(req.userId, buffer.length + (req.files?.thumb?.[0]?.buffer?.length ?? 0)).then(() => null, (error) => error);
  const earlierLookup = uploadKey ? findByUploadKey(req.userId, uploadKey) : null;
  const roomOutcome = assertRoomForDocument(req.userId).then(() => null, (error) => error);
  const topLevelName = !folder || !splitPath(folder).length ? freeName({ userId: req.userId, folder: toDocumentFolder(''), wanted: wantedName }) : null;
  topLevelName?.catch(() => {});

  const earlier = await earlierLookup;
  if (earlier) return res.status(200).json(uploadAnswer(earlier, { replayed: true }));
  const roomError = await roomOutcome;
  if (roomError) throw roomError;

  const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

  const { ciphertext, iv, authTag } = encryptFile(buffer, req.dek);

  const thumbUpload = held ? null : req.files?.thumb?.[0];
  const thumbnail = thumbUpload ? encryptThumbnail(thumbUpload.buffer, thumbUpload.mimetype, req.dek) : null;

  const quotaError = await quotaOutcome;
  if (quotaError) throw quotaError;

  const canonicalFolder = await ensureFolderPath(req.userId, folder || '');
  const documentFolder = toDocumentFolder(canonicalFolder);
  const wanted = wantedName;
  const { name: filename, changed } = canonicalFolder === '' && topLevelName ? await topLevelName : await freeName({ userId: req.userId, folder: documentFolder, wanted });

  let document;
  try {
    document = await Document.create({
      userId: req.userId,
      filename,
      folder: documentFolder,
      encryptedBlob: Buffer.from(ciphertext, 'base64'),
      iv,
      authTag,
      checksum,
      mimeType: mimetype,
      sniffedType: sniffImageType(buffer),
      previewKind: sniffPreviewKind(buffer),
      originDevice: 'pc',
      docExpiresAt,
      syncStatus: 'pending',
      ...(uploadKey ? { uploadKey } : {}),
      ...(thumbnail || {}),
      ...scanFields(scanResult),
    });
  } catch (error) {
    if (uploadKey && isDuplicateKey(error)) {
      const winner = await findByUploadKey(req.userId, uploadKey);
      if (winner) return res.status(200).json(uploadAnswer(winner, { replayed: true }));
    }
    throw error;
  }

  await recordEvent(req, 'upload', { targetId: document._id });
  if (held) await noteHeld(req, document, scanResult);
  res.status(201).json(uploadAnswer(document, changed ? { nameChanged: true, requestedName: wanted } : {}));
});

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
  starred: 1,
  hasNote: 1,
  size: { $binarySize: '$encryptedBlob' },
};

const listDocuments = asyncHandler(async (req, res) => {
  const [, documents, sharedIds] = await Promise.all([
    purgeExpired(req.userId),
    Document.aggregate([
      { $match: { userId: req.userId, deletedAt: null, ...NOT_HELD, ...documentScope(req.emergency) } },
      { $sort: { createdAt: -1 } },
      { $project: LIST_PROJECTION },
    ]),
    req.emergency ? null : activeSharedIds(req.userId),
  ]);
  if (req.emergency) {
    return res.status(200).json(
      documents.map((doc) => {
        // eslint-disable-next-line no-unused-vars -- a note is the owner's alone: not even whether one exists
        const { hasNote, ...summary } = toListSummary(doc, null);
        return { ...summary, folder: toVirtual(req.emergency, summary.folder) };
      })
    );
  }
  res.status(200).json(documents.map((doc) => toListSummary(doc, sharedIds)));
});

const SNIFF_BATCH = 12;

const listPhotos = asyncHandler(async (req, res) => {
  await purgeExpired(req.userId);

  const unclassified = await Document.find({ userId: req.userId, deletedAt: null, ...NOT_HELD, sniffedType: null })
    .select('_id encryptedBlob iv authTag')
    .limit(SNIFF_BATCH);
  for (const doc of unclassified) {
    let type = 'none';
    try {
      const plaintext = decryptFile(doc.encryptedBlob.toString('base64'), req.dek, doc.iv, doc.authTag);
      type = sniffImageType(plaintext);
    } catch {
    }
    // eslint-disable-next-line no-await-in-loop
    await Document.updateOne({ _id: doc._id }, { $set: { sniffedType: type } }, { timestamps: false });
  }

  const [photos, pending] = await Promise.all([
    Document.aggregate([
      { $match: { userId: req.userId, deletedAt: null, ...NOT_HELD, sniffedType: { $in: IMAGE_TYPES } } },
      { $sort: { createdAt: -1 } },
      { $project: LIST_PROJECTION },
    ]),
    Document.countDocuments({ userId: req.userId, deletedAt: null, ...NOT_HELD, sniffedType: null }),
  ]);
  const sharedIds = await activeSharedIds(req.userId);
  res.status(200).json({ photos: photos.map((doc) => toListSummary(doc, sharedIds)), pending });
});

const getStorage = asyncHandler(async (req, res) => {
  res.status(200).json(await getUsage(req.userId));
});

const listFolderChildren = asyncHandler(async (req, res) => {
  const asked = typeof req.query.path === 'string' ? req.query.path : '';
  const requested = toReal(req.emergency, asked);
  if (requested === null) throw httpError(404, 'Folder not found.');
  const canonical = await resolveFolderPath(req.userId, requested);
  if (canonical === null) {
    throw httpError(404, 'Folder not found.');
  }
  if (req.emergency?.scopeMode === 'folders') {
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
  const children = await Folder.find({ userId: req.userId, parentPath: canonical }).select('name parentPath color icon');
  const paths = children.map((folder) => joinPath(canonical, folder.name));
  const withChildren = new Set(
    paths.length ? await Folder.distinct('parentPath', { userId: req.userId, parentPath: { $in: paths } }) : []
  );
  const folders = children
    .map((folder, index) => ({
      name: folder.name,
      path: toVirtual(req.emergency, paths[index]),
      hasChildren: withChildren.has(paths[index]),
      ...(req.emergency ? {} : { color: folder.color ?? null, icon: folder.icon ?? null }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const answer = { path: toVirtual(req.emergency, canonical), folders };
  if (canonical === '' && !req.emergency) {
    const styled = await Folder.find({ userId: req.userId, $or: [{ color: { $exists: true } }, { icon: { $exists: true } }] }).select('name parentPath color icon');
    answer.styles = Object.fromEntries(styled.map((folder) => [joinPath(folder.parentPath || '', folder.name), { color: folder.color ?? null, icon: folder.icon ?? null }]));
    answer.heldCount = await Document.countDocuments({ userId: req.userId, deletedAt: null, 'quarantine.state': 'held' });
  }
  res.status(200).json(answer);
});


const listExpiringDocuments = asyncHandler(async (req, res) => {
  const documents = await Document.find({ userId: req.userId, deletedAt: null, ...NOT_HELD, docExpiresAt: { $ne: null } });

  const expiring = documents
    .map((doc) => toListSummary(doc))
    .filter((doc) => doc.expiryStatus === 'expired' || doc.expiryStatus === 'expiring_soon')
    .sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);

  res.status(200).json(expiring);
});

const listFolders = asyncHandler(async (req, res) => {
  const paths = (await listFolderPaths(req.userId)).filter((path) => pathInScope(req.emergency, path)).map((path) => toVirtual(req.emergency, path));
  const sorted = paths.sort((a, b) => a.localeCompare(b));
  res.status(200).json([FOLDER_ROOT, ...sorted]);
});

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
    const lastSlash = name.lastIndexOf('/');
    parent = lastSlash === -1 ? '' : name.slice(0, lastSlash);
    leaf = lastSlash === -1 ? name : name.slice(lastSlash + 1);
  }

  const { set } = parseFolderStyle(req.body);
  const created = await createFolderExplicit(req.userId, parent, leaf, set);
  res.status(201).json({ name: created });
});

const renameFolder = asyncHandler(async (req, res) => {
  const { path: folderPath, name } = req.body;
  if (typeof folderPath !== 'string' || !folderPath.trim()) {
    throw badRequest('A folder path is required.');
  }
  const style = parseFolderStyle(req.body);
  if (name === undefined && !hasStyleFields(req.body)) throw badRequest('A new name, a colour or an icon is required.');

  const srcPath = await resolveFolderPath(req.userId, folderPath);
  if (!srcPath) throw httpError(404, 'Folder not found.');

  let newPath = srcPath;
  let renamed = false;
  if (name !== undefined) {
    const parent = parentOf(srcPath);
    const newName = validateFolderName(name, { atRoot: !parent });
    ({ newPath } = await runInTransaction((session) => moveFolder(req.userId, srcPath, parent, newName, session)));
    renamed = newPath !== srcPath;
  }
  if (Object.keys(style.set).length || Object.keys(style.unset).length) {
    await Folder.updateOne(
      { userId: req.userId, parentPath: parentOf(newPath), name: lastSegment(newPath) },
      { ...(Object.keys(style.set).length ? { $set: style.set } : {}), ...(Object.keys(style.unset).length ? { $unset: style.unset } : {}) },
      { timestamps: false }
    );
  }
  if (renamed || name !== undefined) await recordEvent(req, 'rename');
  res.status(200).json({ path: newPath });
});

const deleteFolder = asyncHandler(async (req, res) => {
  const { path: folderPath } = req.query;

  if (!folderPath || typeof folderPath !== 'string' || !folderPath.trim()) {
    throw badRequest('A folder path is required.');
  }
  if (folderPath.trim() === FOLDER_ROOT) {
    throw badRequest('"root" cannot be deleted.');
  }

  await trashFolder(req.userId, folderPath.trim());
  await recordEvent(req, 'delete');
  res.status(204).send();
});

const MAX_MOVE_ITEMS = 500;

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

  const folderPaths = new Map();
  const documents = new Map();
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

  const movedFolders = new Set();
  for (const [index, srcPath] of folderPaths) {
    const base = describe(items[index]);
    if (!srcPath) {
      results[index] = { ...base, status: 'not_found', message: 'Folder not found.' };
      continue;
    }
    if (enclosingSelected(srcPath, srcPath)) continue;
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

  for (const [index, srcPath] of folderPaths) {
    if (!srcPath || results[index]) continue;
    results[index] = { ...describe(items[index]), name: lastSegment(srcPath), ...alongWith(srcPath, srcPath) };
  }

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
    await document.save();
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

const updateDocument = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);

  const document = await Document.findOne({ _id: req.params.id, userId: req.userId, deletedAt: null });
  if (!document) {
    throw documentNotFound();
  }

  const { filename, folder, expiryDate, docExpiresAt } = req.body;
  let renamed = false;
  let nameChanged = null;
  let expiryEvent = null;

  if (filename !== undefined) {
    if (typeof filename !== 'string' || !filename.trim()) {
      throw badRequest('filename cannot be empty.');
    }
    const wanted = cleanStoredName(filename);
    const free = await freeName({ userId: req.userId, folder: document.folder, wanted, excludeId: document._id });
    document.filename = free.name;
    nameChanged = free.changed ? wanted : null;
    renamed = true;
  }

  if (folder !== undefined) {
    throw badRequest('Use Move to change which folder a document is in.');
  }

  const incoming = docExpiresAt !== undefined ? docExpiresAt : expiryDate;
  if (incoming !== undefined) {
    let next = null;
    if (incoming !== null) {
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
    await rearmReminders(req.userId, document._id);
    await recordEvent(req, expiryEvent, { targetId: document._id });
  }

  res.status(200).json({ ...toListSummary(document), ...(nameChanged ? { nameChanged: true, requestedName: nameChanged } : {}) });
});

const viewDocument = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);

  const document = await Document.findOne({ _id: req.params.id, userId: req.userId, deletedAt: null, ...documentScope(req.emergency) });
  if (!document) {
    throw documentNotFound();
  }
  assertNotHeld(document);

  const plaintext = decryptFile(
    document.encryptedBlob.toString('base64'),
    req.dek,
    document.iv,
    document.authTag
  );

  const actualChecksum = crypto.createHash('sha256').update(plaintext).digest('hex');
  if (actualChecksum !== document.checksum) {
    const error = new Error('Integrity check failed: this document may be corrupted.');
    error.status = 500;
    error.expose = true;
    throw error;
  }

  const purpose = req.query.for === 'download' || req.query.for === 'silent' ? req.query.for : 'view';
  if (req.emergency) {
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
  res.setHeader('Content-Disposition', contentDisposition(downloadName(document.filename, plaintext)));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(plaintext);
});

const recordDownload = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);
  const document = await Document.findOne({ _id: req.params.id, userId: req.userId, deletedAt: null }).select('_id quarantine');
  if (!document) throw documentNotFound();
  assertNotHeld(document);
  await Document.updateOne(
    { _id: document._id, userId: req.userId },
    { $set: { lastOpenedAt: new Date() }, $inc: { downloadCount: 1 } },
    { timestamps: false }
  );
  await recordEvent(req, 'download', { targetId: document._id });
  res.status(204).send();
});

const getThumbnail = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);

  const document = await Document.findOne({ _id: req.params.id, userId: req.userId, deletedAt: null, ...documentScope(req.emergency) });
  if (document) assertNotHeld(document);
  if (!document || !hasThumbnail(document)) {
    throw documentNotFound();
  }

  let image;
  try {
    image = decryptThumbnail(document, req.dek);
  } catch {
    throw documentNotFound();
  }

  res.setHeader('Content-Type', document.thumbMime);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).send(image);
});

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
  assertNotHeld(document);

  const thumbnail = encryptThumbnail(thumbUpload.buffer, thumbUpload.mimetype, req.dek);
  if (!thumbnail) {
    throw badRequest('Thumbnail must be a WebP or JPEG image of at most 40KB.');
  }

  document.set(thumbnail);
  document.thumbFailedAt = null;
  document.thumbFailReason = null;
  if (!document.previewKind || document.previewKind === 'none') document.previewKind = 'image';
  await document.save();

  res.status(200).json({ id: document._id, hasThumb: true });
});

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

const retryFailedThumbnails = asyncHandler(async (req, res) => {
  const result = await Document.updateMany(
    { userId: req.userId, deletedAt: null, thumbFailedAt: { $ne: null } },
    { $set: { thumbFailedAt: null, thumbFailReason: null } },
    { timestamps: false }
  );
  res.status(200).json({ cleared: result.modifiedCount ?? result.matchedCount ?? 0 });
});

const deleteDocument = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);

  const trashed = await trashDocument(req.userId, req.params.id);
  if (!trashed) {
    throw documentNotFound();
  }

  await recordEvent(req, 'delete', { targetId: req.params.id });
  res.status(204).send();
});

module.exports = {
  toListSummary,
  LIST_PROJECTION,
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
