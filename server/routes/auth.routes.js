const express = require('express');
const router = express.Router();

const { getStatus, setup, unlock } = require('../controllers/auth.controller');

router.get('/status', getStatus);
router.post('/setup', setup);
router.post('/unlock', unlock);

module.exports = router;
