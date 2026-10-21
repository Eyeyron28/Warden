const crypto = require('crypto');
const mongoose = require('mongoose');

const Document = require('../models/Document');
const Folder = require('../models/Folder');
const TrashFolder = require('../models/TrashFolder');
const {
  httpError,
  toNameKey,
  fullPathOf,
  parentOf,
  lastSegment,
  joinPath,
  toDocumentFolder,
  normalizeDocumentFolder,
  folderExistsError,
  resolveFolderPath,
  ensureFolderPath,
  runInTransaction,
} = require('./folders');
const { removeShares } = require('./shareCleanup');
const { dropReminders } = require('./reminderCleanup');
const { dropVersions, pruneOrphanVersions } = require('./versions');
const { freeName } = require('./uniqueName');

const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = RETENTION_DAYS * DAY_MS;

const NAME_EXISTS = 'NAME_EXISTS';

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const asObjectId = (id) => new mongoose.Types.ObjectId(String(id));

function revokeSharesForDocuments(userId, documentIds, session = null) {
  return removeShares({ ownerUserId: userId, sourceDocumentIds: { $in: documentIds.map(asObjectId) } }, { session });
}

async function trashDocument(userId, documentId) {
  if (!mongoose.Types.ObjectId.isValid(documentId)) return null;
  const existing = await Document.findOne({ _id: documentId, userId, deletedAt: null }).select('_id');
  if (!existing) return null;

  await revokeSharesForDocuments(userId, [existing._id]);

  const now = new Date();
  const result = await Document.updateOne(
    { _id: existing._id, userId, deletedAt: null },
    { $set: { deletedAt: now, purgeAt: new Date(now.getTime() + RETENTION_MS), trashBatchId: null } }
  );
  return result.matchedCount === 0 ? null : { id: existing._id, purgeAt: new Date(now.getTime() + RETENTION_MS) };
}

async function trashFolder(userId, path) {
  const canonical = await resolveFolderPath(userId, path);
  if (canonical === null || canonical === '') return null;

  const prefix = `^${escapeRegex(canonical)}/`;
  const folderFilter = {
    userId,
    $or: [
      { parentPath: parentOf(canonical), nameKey: toNameKey(lastSegment(canonical)) },
      { parentPath: canonical },
      { parentPath: { $regex: prefix } },
    ],
  };
  const documentFilter = {
    userId,
    deletedAt: null,
    $or: [{ folder: canonical }, { folder: { $regex: prefix } }],
  };

  return runInTransaction(async (session) => {
    const folders = await Folder.find(folderFilter).session(session || null);
    const docs = await Document.find(documentFilter).select('_id folder').session(session || null);
    const [sizes] = await Document.aggregate([
      { $match: documentFilter },
      { $group: { _id: null, bytes: { $sum: { $binarySize: '$encryptedBlob' } } } },
    ]).session(session || null);

    const subPaths = new Set([canonical, ...folders.map(fullPathOf), ...docs.map((doc) => normalizeDocumentFolder(doc.folder))]);
    const batchId = crypto.randomBytes(16).toString('hex');
    const now = new Date();
    const purgeAt = new Date(now.getTime() + RETENTION_MS);
    const opts = session ? { session } : {};

    await revokeSharesForDocuments(userId, docs.map((doc) => doc._id), session);
    await TrashFolder.create(
      [
        {
          userId,
          batchId,
          path: canonical,
          parentPath: parentOf(canonical),
          name: lastSegment(canonical),
          subPaths: [...subPaths].filter(Boolean),
          itemCount: docs.length,
          totalBytes: sizes?.bytes ?? 0,
          deletedAt: now,
          purgeAt,
        },
      ],
      opts
    );
    await Document.updateMany(documentFilter, { $set: { deletedAt: now, purgeAt, trashBatchId: batchId } }, opts);
    await Folder.deleteMany(folderFilter, opts);
    return { batchId, name: lastSegment(canonical), itemCount: docs.length };
  });
}

function daysLeft(purgeAt, now = new Date()) {
  return Math.max(0, Math.ceil((purgeAt.getTime() - now.getTime()) / DAY_MS));
}

async function listTrash(userId) {
  const now = new Date();
  await purgeExpired(userId, now);

  const [files, folders] = await Promise.all([
    Document.aggregate([
      { $match: { userId, deletedAt: { $ne: null }, trashBatchId: null } },
      {
        $project: {
          filename: 1,
          folder: 1,
          deletedAt: 1,
          purgeAt: 1,
          sniffedType: 1,
          thumbMime: 1,
          size: { $binarySize: '$encryptedBlob' },
        },
      },
    ]),
    TrashFolder.find({ userId }),
  ]);

  const items = [
    ...files.map((doc) => ({
      kind: 'file',
      id: String(doc._id),
      name: doc.filename,
      originalLocation: normalizeDocumentFolder(doc.folder),
      itemCount: 1,
      size: doc.size,
      sniffedType: doc.sniffedType ?? null,
      hasThumb: Boolean(doc.thumbMime),
      deletedAt: doc.deletedAt,
      purgeAt: doc.purgeAt,
      daysLeft: daysLeft(doc.purgeAt, now),
    })),
    ...folders.map((folder) => ({
      kind: 'folder',
      id: folder.batchId,
      name: folder.name,
      originalLocation: folder.parentPath || '',
      itemCount: folder.itemCount,
      size: folder.totalBytes,
      sniffedType: null,
      hasThumb: false,
      deletedAt: folder.deletedAt,
      purgeAt: folder.purgeAt,
      daysLeft: daysLeft(folder.purgeAt, now),
    })),
  ];
  items.sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());
  return { items, retentionDays: RETENTION_DAYS };
}

async function restoreFile(userId, documentId) {
  if (!mongoose.Types.ObjectId.isValid(documentId)) throw httpError(404, 'Item not found.');
  const doc = await Document.findOne({ _id: documentId, userId, deletedAt: { $ne: null }, trashBatchId: null }).select(
    'filename folder'
  );
  if (!doc) throw httpError(404, 'Item not found.');

  let destination = await resolveFolderPath(userId, normalizeDocumentFolder(doc.folder));
  let message = null;
  if (destination === null) {
    destination = '';
    message = 'The original folder no longer exists, so it was restored to the top level.';
  }
  const free = await freeName({ userId, folder: toDocumentFolder(destination), wanted: doc.filename, excludeId: doc._id });
  if (free.changed) {
    const note = `A file named "${doc.filename}" is already there, so it was restored as "${free.name}".`;
    message = message ? `${message} ${note}` : note;
  }

  await Document.updateOne(
    { _id: doc._id, userId },
    { $set: { deletedAt: null, purgeAt: null, folder: toDocumentFolder(destination), filename: free.name } }
  );
  return { kind: 'file', id: String(doc._id), restoredTo: destination, message, name: free.name, nameChanged: free.changed };
}

async function restoreFolder(userId, batchId) {
  const trashed = typeof batchId === 'string' ? await TrashFolder.findOne({ userId, batchId }) : null;
  if (!trashed) throw httpError(404, 'Item not found.');

  let parent = await resolveFolderPath(userId, trashed.parentPath);
  let message = null;
  if (parent === null) {
    parent = '';
    message = 'The original folder no longer exists, so it was restored to the top level.';
  }
  const taken = async (where) => {
    const existing = await resolveFolderPath(userId, joinPath(where, trashed.name));
    return existing !== null;
  };
  if (await taken(parent)) {
    if (parent === '') throw folderExistsError(trashed.name);
    parent = '';
    message = 'A folder with that name already exists in the original location, so it was restored to the top level.';
    if (await taken('')) throw folderExistsError(trashed.name);
  }

  const newPath = joinPath(parent, trashed.name);
  const relocate = (path) => (path === trashed.path ? newPath : `${newPath}${path.slice(trashed.path.length)}`);

  await runInTransaction(async (session) => {
    const opts = session ? { session } : {};
    const ordered = [...trashed.subPaths].sort((a, b) => a.split('/').length - b.split('/').length);
    for (const subPath of ordered) {
      // eslint-disable-next-line no-await-in-loop
      await ensureFolderPath(userId, relocate(subPath), session);
    }
    const folderPaths = await Document.distinct('folder', { userId, trashBatchId: batchId });
    for (const oldFolder of folderPaths) {
      // eslint-disable-next-line no-await-in-loop
      await Document.updateMany(
        { userId, trashBatchId: batchId, folder: oldFolder },
        { $set: { folder: toDocumentFolder(relocate(normalizeDocumentFolder(oldFolder))), deletedAt: null, purgeAt: null, trashBatchId: null } },
        opts
      );
    }
    await TrashFolder.deleteOne({ _id: trashed._id }, opts);
  });
  return { kind: 'folder', id: batchId, restoredTo: parent, path: newPath, message };
}

async function deletePermanently(userId, kind, id) {
  if (kind === 'file') {
    if (!mongoose.Types.ObjectId.isValid(id)) throw httpError(404, 'Item not found.');
    const result = await Document.deleteOne({ _id: id, userId, deletedAt: { $ne: null }, trashBatchId: null });
    if (result.deletedCount) await dropVersions(userId, [id]);
    if (result.deletedCount === 0) throw httpError(404, 'Item not found.');
    await dropReminders(userId, [id]);
    return { deletedDocuments: 1 };
  }
  if (kind === 'folder') {
    const trashed = typeof id === 'string' ? await TrashFolder.findOne({ userId, batchId: id }) : null;
    if (!trashed) throw httpError(404, 'Item not found.');
    const goneIds = await Document.distinct('_id', { userId, trashBatchId: id });
    const result = await Document.deleteMany({ userId, trashBatchId: id });
    await dropReminders(userId, goneIds);
    await dropVersions(userId, goneIds);
    await TrashFolder.deleteOne({ _id: trashed._id });
    return { deletedDocuments: result.deletedCount };
  }
  throw httpError(400, 'Unknown item kind.');
}

async function emptyTrash(userId) {
  const goneIds = await Document.distinct('_id', { userId, deletedAt: { $ne: null } });
  const documents = await Document.deleteMany({ userId, deletedAt: { $ne: null } });
  await dropReminders(userId, goneIds);
  await dropVersions(userId, goneIds);
  const folders = await TrashFolder.deleteMany({ userId });
  return { deletedDocuments: documents.deletedCount, deletedFolders: folders.deletedCount };
}

async function purgeExpired(userId = null, now = new Date()) {
  const scope = userId ? { userId } : {};
  const goneIds = await Document.distinct('_id', { ...scope, purgeAt: { $lte: now } });
  const documents = await Document.deleteMany({ ...scope, purgeAt: { $lte: now } });
  await dropReminders(null, goneIds);
  await dropVersions(null, goneIds);
  await pruneOrphanVersions(userId);
  const folders = await TrashFolder.deleteMany({ ...scope, purgeAt: { $lte: now } });
  return { deletedDocuments: documents.deletedCount, deletedFolders: folders.deletedCount };
}

module.exports = {
  RETENTION_DAYS,
  NAME_EXISTS,
  trashDocument,
  trashFolder,
  listTrash,
  restoreFile,
  restoreFolder,
  deletePermanently,
  emptyTrash,
  purgeExpired,
  revokeSharesForDocuments,
};
