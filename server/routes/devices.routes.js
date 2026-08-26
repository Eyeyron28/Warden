const express = require('express');

const requireSession = require('../middleware/requireSession');
const { listDevices, revokeDevice } = require('../controllers/devices.controller');

// Owner-only device management - list paired devices and revoke one.
// requireSession is applied per-route rather than via a blanket
// router.use(), matching the convention established for pairing.routes.js
// and sync.routes.js: keeps this router correct regardless of whatever
// else might ever get mounted at this same /api/devices prefix.
const router = express.Router();
router.get('/', requireSession, listDevices);
router.post('/:id/revoke', requireSession, revokeDevice);

module.exports = router;
