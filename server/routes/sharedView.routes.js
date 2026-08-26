const express = require('express');

const createRateLimiter = require('../middleware/rateLimit');
const { viewSharedDocument } = require('../controllers/sharedView.controller');

// No requireSession anywhere in this file - deliberately. This is the
// public trust boundary: the share token in the URL IS the credential
// (see controllers/sharedView.controller.js for how the document's DEK
// is reached without a session at all).
const router = express.Router();

// "A handful of requests per minute" per the design: generous enough that
// a real recipient reloading/retrying on a flaky connection won't get
// blocked, but enough of a ceiling that scripted token-guessing against
// this credential-free route costs real wall-clock time. The token's own
// 256 bits of entropy is the actual security boundary; this is basic
// hygiene on top of it, not a substitute for it.
router.get('/:token', createRateLimiter({ max: 10, windowMs: 60 * 1000 }), viewSharedDocument);

module.exports = router;
