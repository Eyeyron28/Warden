const express = require('express');
const router = express.Router();

const { getStatus, setup, unlock, recover, logout } = require('../controllers/auth.controller');
const requireSession = require('../middleware/requireSession');

router.get('/status', getStatus);
router.post('/setup', setup);
router.post('/unlock', unlock);
router.post('/recover', recover);
router.post('/logout', requireSession, logout);

module.exports = router;
