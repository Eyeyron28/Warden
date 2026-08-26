const express = require('express');

const createRateLimiter = require('../middleware/rateLimit');
const { completePairing } = require('../controllers/pairing.controller');

// Deliberately NOT behind requireSession anywhere in this file - the
// phone has no session yet. The pairingToken in the request body IS the
// credential, same trust model as GET /api/shared/:token, so this is
// mounted separately from routes/pairing.routes.js (which requires an
// owner session on every route it defines).
const router = express.Router();

// Same reasoning as the share-view rate limit: a wrong master password
// doesn't consume the pairing token (so a mistyped password can be
// retried), which means this is the one other place in the app where a
// credential can be guessed repeatedly without anything else stopping
// it. scrypt itself is already slow per attempt; this is defense in
// depth on top of that, not a substitute for it.
router.post('/complete', createRateLimiter({ max: 10, windowMs: 60 * 1000 }), completePairing);

module.exports = router;
