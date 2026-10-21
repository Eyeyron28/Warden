const trash = require('../utils/trash');
const { recordEvent } = require('../utils/audit');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const listTrash = asyncHandler(async (req, res) => {
  res.status(200).json(await trash.listTrash(req.userId));
});

const restoreItem = asyncHandler(async (req, res) => {
  const { kind, id } = req.body || {};
  if (typeof id !== 'string') {
    const error = new Error('An item id is required.');
    error.status = 400;
    throw error;
  }
  if (kind === 'file') {
    const restored = await trash.restoreFile(req.userId, id);
    await recordEvent(req, 'restore', { targetId: id });
    res.status(200).json(restored);
  } else if (kind === 'folder') {
    const restored = await trash.restoreFolder(req.userId, id);
    await recordEvent(req, 'restore');
    res.status(200).json(restored);
  } else {
    const error = new Error('kind must be "file" or "folder".');
    error.status = 400;
    throw error;
  }
});

const deleteItem = asyncHandler(async (req, res) => {
  await trash.deletePermanently(req.userId, req.params.kind, req.params.id);
  await recordEvent(req, 'delete', { targetId: req.params.kind === 'file' ? req.params.id : null });
  res.status(204).send();
});

const emptyTrash = asyncHandler(async (req, res) => {
  const emptied = await trash.emptyTrash(req.userId);
  await recordEvent(req, 'trash_emptied');
  res.status(200).json(emptied);
});

module.exports = { listTrash, restoreItem, deleteItem, emptyTrash };
