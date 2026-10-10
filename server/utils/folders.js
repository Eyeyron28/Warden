const mongoose = require('mongoose');

const Folder = require('../models/Folder');
const Document = require('../models/Document');

/**
 * The one place folder naming rules live. Every code path that creates,
 * renames or moves a folder - or files a document somewhere - goes through
 * these helpers, so "Josh" / "josh" / " Josh " can never become two folders
 * in the same parent no matter where the path came from.
 *
 * Paths are slash-delimited strings ("Taxes/2024"); "" (or the legacy
 * Document.folder value "root") means the top level.
 */

const FOLDER_ROOT = 'root';
const MAX_FOLDER_NAME_LENGTH = 100;

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  // An app-authored 5xx message is written for the user; any other 5xx is replaced by the error handler.
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

/** "" -> "root" (the value Document.folder has always used for top level). */
function toDocumentFolder(path) {
  return path || FOLDER_ROOT;
}

/** "root"/undefined -> "", everything else unchanged. */
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

/**
 * Validates a folder name typed by a person (New folder, rename). Implicit
 * paths (uploads, sync) never go through this - see ensureFolderPath.
 */
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

/**
 * Resolves an existing path case-insensitively to its canonical spelling,
 * WITHOUT creating anything. Returns "" for the top level, or null if any
 * segment doesn't exist.
 */
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

/**
 * IMPLICIT folder creation - uploads, folder uploads, phone sync, backup
 * import. Never errors on a name collision: each segment resolves
 * case-insensitively to the existing folder ("josh/2024" files into an
 * existing "Josh/2024"), and only the missing segments are created. Returns
 * the canonical path ("" for top level).
 *
 * The upsert is race-safe: two concurrent requests creating the same
 * segment both land on the one document the unique index allows; the loser
 * of a genuine insert race (E11000) just re-reads the winner's record.
 */
async function ensureFolderPath(userId, path, session) {
  let current = '';
  const segments = splitPath(path);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    // A top-level segment literally named "root" would be indistinguishable
    // from Document.folder's own "root" (= top level) - treat it as that.
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

/**
 * EXPLICIT creation (the New folder dialog). Parents resolve/create like
 * any implicit path; the new last segment itself must not already exist in
 * that parent (case-insensitively), otherwise 409 FOLDER_EXISTS. Returns the
 * new folder's full path.
 */
async function createFolderExplicit(userId, parentPathInput, rawName) {
  const parentPath = await ensureFolderPath(userId, parentPathInput);
  const name = validateFolderName(rawName, { atRoot: !parentPath });

  const existing = await findChild(userId, parentPath, name);
  if (existing) throw folderExistsError(existing.name);

  try {
    await Folder.create({ userId, parentPath, name, nameKey: toNameKey(name) });
  } catch (err) {
    if (err?.code === 11000) throw folderExistsError(name);
    throw err;
  }
  return joinPath(parentPath, name);
}

/**
 * Rewrites a path prefix on every matching record in `collection` - the
 * field itself if it equals oldPrefix, or the leading part of it if it's a
 * descendant ("Old/x" -> "New/x"). One updateMany per collection, using an
 * aggregation-pipeline update so the rewrite happens server-side, and
 * updatedAt is bumped on everything touched (phone sync relies on moved
 * documents showing their new folder on the next pull).
 */
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

/**
 * Moves and/or renames one folder: `srcPath` becomes `${destParent}/${newName}`.
 * Shared by Move (new parent, same name) and Rename (same parent, new
 * name). Both paths must already be canonical (resolveFolderPath).
 *
 * Runs inside the caller's transaction (see runInTransaction) - the folder
 * record, every descendant folder record, and every document inside are
 * rewritten together, then verified, so a failure part-way through can't
 * leave the tree half-moved.
 *
 * @returns {Promise<{ newPath: string, unchanged: boolean }>}
 */
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
  // Documents in Trash are left alone: a trashed FOLDER's documents must keep the
  // paths its Trash entry remembers, and a trashed file restores by its original path.
  await rewritePrefix(Document.collection, 'folder', userId, srcPath, newPath, session, { deletedAt: null });

  // Verification: nothing may still sit under the old path. Inside a
  // transaction this aborts the whole move; in the non-transactional
  // fallback it at least surfaces the inconsistency instead of reporting
  // success.
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

/**
 * Runs fn(session) in a MongoDB transaction (Atlas, including M0, supports
 * them - it's always a replica set). If the deployment can't do
 * transactions at all (a standalone local mongod), falls back to running
 * fn(null) as an ordered sequence of writes; moveFolder's own verification
 * step still catches an inconsistent result there, it just can't roll it
 * back. The fallback is logged so it never happens silently.
 */
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

/**
 * Lists every folder path in an account (canonical spelling), for the
 * client's tree and the phone's sync. Unioned with documents' own folder
 * strings purely as a safety net for data written before this model.
 */
async function listFolderPaths(userId) {
  const [folders, documentFolders] = await Promise.all([
    Folder.find({ userId }, 'parentPath name'),
    Document.distinct('folder', { userId, deletedAt: null }),
  ]);
  const paths = new Set(folders.map(fullPathOf));
  documentFolders.forEach((folder) => {
    const path = normalizeDocumentFolder(folder);
    if (path) paths.add(path);
  });
  return [...paths];
}

/**
 * Deletes a folder record and every descendant folder record. Documents are
 * deleted separately by the caller (the client deletes them one by one
 * first). Anything that's still filed under the path afterwards gets its
 * folders re-created, so a document is never left pointing at a path with
 * no Folder records behind it.
 */
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
