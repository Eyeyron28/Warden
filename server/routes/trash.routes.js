const express = require('express');

const requireSession = require('../middleware/requireSession');
const { listTrash, restoreItem, deleteItem, emptyTrash } = require('../controllers/trash.controller');

// Trash is the owner's, behind an unlocked session only (a paired phone has no
// access to it). Every lookup is scoped by the account, so another account's
// item is a plain 404.
const router = express.Router();
router.use(requireSession);

router.get('/', listTrash);
router.post('/restore', restoreItem);
router.delete('/', emptyTrash);
router.delete('/:kind/:id', deleteItem);

module.exports = router;
