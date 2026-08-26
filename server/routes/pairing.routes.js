const express = require('express');

const requireSession = require('../middleware/requireSession');
const { initPairing, getPairingStatus } = require('../controllers/pairing.controller');

// Owner-only, unlike POST /api/pair/complete (routes/pairComplete.routes.js)
// which is mounted at this same /api/pair prefix. requireSession is
// applied per-route here rather than via a blanket router.use() - an
// unconditional router.use(requireSession) would run for ANY path
// Express forwards into this router, including /complete, since Express
// only strips the mount prefix before delegating and does not know in
// advance which of the two sibling routers actually owns a given
// sub-path. Scoping it to each route instead means this router simply
// never touches a /complete request at all, regardless of mount order.
const router = express.Router();
router.post('/init', requireSession, initPairing);
router.get('/status/:token', requireSession, getPairingStatus);

module.exports = router;
