const express = require('express');
const router = express.Router();

const requireSession = require('../middleware/requireSession');
const { exportBackup, importBackup, getStatus } = require('../controllers/backup.controller');

// Every route requires a logged-in account - exporting or importing an
// account's contents (even as ciphertext) shouldn't be reachable without
// one. The old single-vault version of /import had a second,
// unauthenticated "fresh install" path; that's retired now that "no
// account exists yet" isn't a meaningful state in a multi-user app (see
// controllers/backup.controller.js importBackup for the reasoning).
router.use(requireSession);

router.post('/export', exportBackup);
router.post('/import', importBackup);
router.get('/status', getStatus);

module.exports = router;
