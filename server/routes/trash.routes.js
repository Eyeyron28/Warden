const express = require('express');

const requireSession = require('../middleware/requireSession');
const { listTrash, restoreItem, deleteItem, emptyTrash } = require('../controllers/trash.controller');

const router = express.Router();
router.use(requireSession);

router.get('/', listTrash);
router.post('/restore', restoreItem);
router.delete('/', emptyTrash);
router.delete('/:kind/:id', deleteItem);

module.exports = router;
