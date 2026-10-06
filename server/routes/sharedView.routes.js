const express = require('express');

const createRateLimiter = require('../middleware/rateLimit');
const { viewSharedManifest, viewSharedFile } = require('../controllers/sharedView.controller');

// No requireSession anywhere in this file - deliberately. This is the
// public side of a share, and it only ever serves ciphertext: the key that
// opens it is in the link's #fragment and never reaches the server (see
// controllers/sharedView.controller.js).
const router = express.Router();

// "A handful of requests per minute" per the design: generous enough that
// a real recipient reloading/retrying on a flaky connection won't get
// blocked, but enough of a ceiling that scripted token-guessing against
// this credential-free route costs real wall-clock time. The 128-bit random
// shareId, and the key that is never sent here at all, are the actual
// security boundary; this is basic hygiene on top of it.
router.get(
  '/:shareId',
  createRateLimiter({ name: 'shared-view-manifest', max: 10, windowMs: 60 * 1000 }),
  viewSharedManifest
);

// Separate (higher) bucket: one link can carry many files and "download all"
// fetches each one, so this can't share the manifest's tight ceiling.
router.get(
  '/:shareId/files/:fileId',
  createRateLimiter({ name: 'shared-view-file', max: 120, windowMs: 60 * 1000 }),
  viewSharedFile
);

module.exports = router;
