const express = require('express');

const requireSession = require('../middleware/requireSession');
const { listHeld } = require('../controllers/quarantine.controller');

const router = express.Router();

// Every route requires an unlocked vault session (an Emergency Access session is refused by requireSession's allowlist).
router.use(requireSession);
router.get('/', listHeld);

module.exports = router;
