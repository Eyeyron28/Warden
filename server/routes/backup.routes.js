const express = require('express');
const router = express.Router();

const requireSession = require('../middleware/requireSession');
const { exportBackup, importBackup, getStatus } = require('../controllers/backup.controller');

// Every route below requires an unlocked vault session - exporting or
// importing the vault's contents (even as ciphertext) shouldn't be
// reachable without one.
router.use(requireSession);

router.post('/export', exportBackup);
router.post('/import', importBackup);
router.get('/status', getStatus);

module.exports = router;
