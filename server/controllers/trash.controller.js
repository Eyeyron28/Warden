const trash = require('../utils/trash');

// Routes are async, but Express doesn't forward rejected promises to
// error-handling middleware on its own - this small wrapper does that.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * GET /api/trash
 * Everything in this account's Trash, newest first, with where it was, when it
 * was deleted and how many days are left before it is removed for good.
 */
const listTrash = asyncHandler(async (req, res) => {
  res.status(200).json(await trash.listTrash(req.userId));
});

/**
 * POST /api/trash/restore
 * Body: { kind: 'file' | 'folder', id }
 * Restores to the original place, or to the top level (with a message) if that
 * place is gone or the name is taken; 409 if the top level has the name too.
 */
const restoreItem = asyncHandler(async (req, res) => {
  const { kind, id } = req.body || {};
  if (typeof id !== 'string') {
    const error = new Error('An item id is required.');
    error.status = 400;
    throw error;
  }
  if (kind === 'file') {
    res.status(200).json(await trash.restoreFile(req.userId, id));
  } else if (kind === 'folder') {
    res.status(200).json(await trash.restoreFolder(req.userId, id));
  } else {
    const error = new Error('kind must be "file" or "folder".');
    error.status = 400;
    throw error;
  }
});

/**
 * DELETE /api/trash/:kind/:id
 * Deletes one trashed item permanently (the encrypted data and thumbnail go with it).
 */
const deleteItem = asyncHandler(async (req, res) => {
  await trash.deletePermanently(req.userId, req.params.kind, req.params.id);
  res.status(204).send();
});

/**
 * DELETE /api/trash
 * Empties the Trash: every trashed item is deleted permanently.
 */
const emptyTrash = asyncHandler(async (req, res) => {
  res.status(200).json(await trash.emptyTrash(req.userId));
});

module.exports = { listTrash, restoreItem, deleteItem, emptyTrash };
