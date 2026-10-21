const mongoose = require('mongoose');

const Folder = require('../models/Folder');
const Document = require('../models/Document');
const { NOT_HELD } = require('../utils/quarantineFilter');

const FOLDER_ROOT = 'root';
const MAX_FOLDER_NAME_LENGTH = 100;

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (status >= 500) error.expose = true;
  if (code) error.code = code;
  return error;
}

function toNameKey(name) {
  return name.trim().toLowerCase();
}

function splitPath(path) {
  if (!path || path === FOLDER_ROOT) return [];
  return path
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function joinPath(parentPath, name) {
  return parentPath ? `${parentPath}/${name}` : name;
}

function fullPathOf(folder) {
  return joinPath(folder.parentPath, folder.name);
}

function parentOf(path) {
  const segments = splitPath(path);
  return segments.slice(0, -1).join('/');
}

function lastSegment(path) {
  const segments = splitPath(path);
  return segments[segments.length - 1] || '';
}

function toDocumentFolder(path) {
  return path || FOLDER_ROOT;
}

function normalizeDocumentFolder(folder) {
  return !folder || folder === FOLDER_ROOT ? '' : folder;
}

function isSameOrDescendant(path, ancestor) {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function folderExistsError(name) {
  return httpError(409, `A folder named "${name}" already exists here.`, 'FOLDER_EXISTS');
}

function validateFolderName(raw, { atRoot = false } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw httpError(400, 'A folder name is required.');
  }
  const name = raw.trim();
  if (name.length > MAX_FOLDER_NAME_LENGTH) {
    throw httpError(400, `Folder names can be at most ${MAX_FOLDER_NAME_LENGTH} characters.`);
  }
  if (/[\\/]/.test(name)) {
    throw httpError(400, 'Folder names can\'t contain "/" or "\\".');
  }
  if (atRoot && toNameKey(name) === FOLDER_ROOT) {
    throw httpError(400, '"root" is reserved for uncategorized documents.');
  }
  return name;
}

function findChild(userId, parentPath, name, session) {
  return Folder.findOne({ userId, parentPath, nameKey: toNameKey(name) }).session(session || null);
}

async function resolveFolderPath(userId, path, session) {
  let current = '';
  for (const segment of splitPath(path)) {
    // eslint-disable-next-line no-await-in-loop
    const folder = await findChild(userId, current, segment, session);
    if (!folder) return null;
    current = fullPathOf(folder);
  }
  return current;
}

async function ensureFolderPath(userId, path, session) {
  let current = '';
  const segments = splitPath(path);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (index === 0 && toNameKey(segment) === FOLDER_ROOT) continue;

    const nameKey = toNameKey(segment);
    const filter = { userId, parentPath: current, nameKey };
    let folder;
    try {
      // eslint-disable-next-line no-await-in-loop
      folder = await Folder.findOneAndUpdate(
        filter,
        { $setOnInsert: { name: segment } },
        { upsert: true, new: true, session: session || undefined }
      );
    } catch (err) {
      if (err?.code !== 11000) throw err;
      // eslint-disable-next-line no-await-in-loop
      folder = await Folder.findOne(filter).session(session || null);
    }
    current = fullPathOf(folder);
  }
  return current;
}

async function createFolderExplicit(userId, parentPathInput, rawName, style = {}) {
  const parentPath = await ensureFolderPath(userId, parentPathInput);
  const name = validateFolderName(rawName, { atRoot: !parentPath });

  const existing = await findChild(userId, parentPath, name);
  if (existing) throw folderExistsError(existing.name);

  try {
    await Folder.create({ userId, parentPath, name, nameKey: toNameKey(name), ...style });
  } catch (err) {
    if (err?.code === 11000) throw folderExistsError(name);
    throw err;
  }
  return joinPath(parentPath, name);
}

async function rewritePrefix(collection, field, userId, oldPrefix, newPrefix, session, extraFilter = {}) {
  const oldLength = [...oldPrefix].length;
  await collection.updateMany(
    {
      ...extraFilter,
      userId: new mongoose.Types.ObjectId(String(userId)),
      $or: [{ [field]: oldPrefix }, { [field]: { $regex: `^${escapeRegex(oldPrefix)}/` } }],
    },
    [
      {
        $set: {
          [field]: {
            $concat: [
              newPrefix,
              {
                $substrCP: [
                  `$${field}`,
                  oldLength,
                  { $subtract: [{ $strLenCP: `$${field}` }, oldLength] },
                ],
              },
            ],
          },
          updatedAt: '$$NOW',
        },
      },
    ],
    { session: session || undefined }
  );
}

async function moveFolder(userId, srcPath, destParent, newName, session) {
  const src = await findChild(userId, parentOf(srcPath), lastSegment(srcPath), session);
  if (!src || fullPathOf(src) !== srcPath) {
    throw httpError(404, 'Folder not found.');
  }

  if (isSameOrDescendant(destParent, srcPath)) {
    throw httpError(400, `You can't move "${src.name}" into itself or one of its own subfolders.`);
  }

  const clash = await Folder.findOne({
    userId,
    parentPath: destParent,
    nameKey: toNameKey(newName),
    _id: { $ne: src._id },
  }).session(session || null);
  if (clash) throw folderExistsError(clash.name);

  const newPath = joinPath(destParent, newName);
  if (newPath === srcPath) return { newPath, unchanged: true };

  src.parentPath = destParent;
  src.name = newName;
  src.nameKey = toNameKey(newName);
  try {
    await src.save({ session: session || undefined });
  } catch (err) {
    if (err?.code === 11000) throw folderExistsError(newName);
    throw err;
  }

  await rewritePrefix(Folder.collection, 'parentPath', userId, srcPath, newPath, session);
  await rewritePrefix(Document.collection, 'folder', userId, srcPath, newPath, session, { deletedAt: null });

  const escaped = escapeRegex(srcPath);
  const leftovers = await Promise.all([
    Folder.countDocuments({
      userId,
      $or: [{ parentPath: srcPath }, { parentPath: { $regex: `^${escaped}/` } }],
    }).session(session || null),
    Document.countDocuments({
      userId,
      deletedAt: null,
      $or: [{ folder: srcPath }, { folder: { $regex: `^${escaped}/` } }],
    }).session(session || null),
  ]);
  if (leftovers[0] + leftovers[1] > 0) {
    throw httpError(500, 'Move could not be completed consistently. Nothing was changed.');
  }

  return { newPath, unchanged: false };
}

function isTransactionUnsupported(err) {
  return (
    err?.code === 20 ||
    err?.codeName === 'IllegalOperation' ||
    /Transaction numbers are only allowed/i.test(err?.message || '')
  );
}

async function runInTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } catch (err) {
    if (!isTransactionUnsupported(err)) throw err;
    console.warn('Transactions unsupported on this MongoDB deployment - running folder move without one.');
    return fn(null);
  } finally {
    await session.endSession();
  }
}

async function listFolderPaths(userId) {
  const [folders, documentFolders] = await Promise.all([
    Folder.find({ userId }, 'parentPath name'),
    Document.distinct('folder', { userId, deletedAt: null, ...NOT_HELD }),
  ]);
  const paths = new Set(folders.map(fullPathOf));
  documentFolders.forEach((folder) => {
    const path = normalizeDocumentFolder(folder);
    if (path) paths.add(path);
  });
  return [...paths];
}

async function deleteFolderTree(userId, path) {
  const canonical = await resolveFolderPath(userId, path);
  if (canonical === null || canonical === '') return;

  const escaped = escapeRegex(canonical);
  await Folder.deleteMany({
    userId,
    $or: [
      { parentPath: parentOf(canonical), nameKey: toNameKey(lastSegment(canonical)) },
      { parentPath: canonical },
      { parentPath: { $regex: `^${escaped}/` } },
    ],
  });

  const leftovers = await Document.distinct('folder', {
    userId,
    deletedAt: null,
    $or: [{ folder: canonical }, { folder: { $regex: `^${escaped}/` } }],
  });
  for (const folder of leftovers) {
    // eslint-disable-next-line no-await-in-loop
    await ensureFolderPath(userId, folder);
  }
}

module.exports = {
  FOLDER_ROOT,
  MAX_FOLDER_NAME_LENGTH,
  httpError,
  toNameKey,
  splitPath,
  joinPath,
  fullPathOf,
  parentOf,
  lastSegment,
  toDocumentFolder,
  normalizeDocumentFolder,
  isSameOrDescendant,
  validateFolderName,
  folderExistsError,
  resolveFolderPath,
  ensureFolderPath,
  createFolderExplicit,
  moveFolder,
  runInTransaction,
  listFolderPaths,
  deleteFolderTree,
};
