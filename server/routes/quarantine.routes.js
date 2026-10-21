const express = require('express');

const requireSession = require('../middleware/requireSession');
const { listHeld } = require('../controllers/quarantine.controller');

const router = express.Router();

router.use(requireSession);
router.get('/', listHeld);

module.exports = router;
