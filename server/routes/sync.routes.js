const express = require('express');

const requireDeviceAuth = require('../middleware/requireDeviceAuth');
const { pullDocuments, pushDocuments } = require('../controllers/sync.controller');

// requireDeviceAuth is applied per-route rather than via a blanket
// router.use(), matching the fix applied to routes/pairing.routes.js -
// keeps this router correct regardless of whether anything else ever
// gets mounted at this same /api/sync prefix later.
const router = express.Router();
router.post('/pull', requireDeviceAuth, pullDocuments);
router.post('/push', requireDeviceAuth, pushDocuments);

module.exports = router;
