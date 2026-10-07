const express = require('express');

const createRateLimiter = require('../middleware/rateLimit');
const {
  openAccess,
  requestEmailCode,
  verifyEmailCode,
  unlockPassword,
  viewSharedManifest,
  viewSharedFile,
} = require('../controllers/sharedView.controller');

// No requireSession anywhere in this file - deliberately. This is the
// public side of a share, and it only ever serves ciphertext: the key that
// opens it is in the link's #fragment (or wrapped under a password) and never
// reaches the server (see controllers/sharedView.controller.js).
const router = express.Router();

// Every route is limited per connection; the guessable things (the emailed
// code, the password) are ALSO limited per share inside their handlers, so
// moving between connections does not give more guesses.
router.post(
  '/:shareId/access',
  createRateLimiter({ name: 'shared-access', max: 30, windowMs: 60 * 1000 }),
  openAccess
);
router.post(
  '/:shareId/email-code',
  createRateLimiter({ name: 'shared-email-code', max: 10, windowMs: 60 * 60 * 1000 }),
  requestEmailCode
);
router.post(
  '/:shareId/email-verify',
  createRateLimiter({ name: 'shared-email-verify', max: 30, windowMs: 15 * 60 * 1000 }),
  verifyEmailCode
);
router.post(
  '/:shareId/unlock',
  createRateLimiter({ name: 'shared-unlock', max: 30, windowMs: 15 * 60 * 1000 }),
  unlockPassword
);

// "A handful of requests per minute": generous enough that a real recipient
// reloading/retrying won't get blocked, but enough of a ceiling that scripted
// guessing against this credential-free route costs real wall-clock time.
router.get(
  '/:shareId',
  createRateLimiter({ name: 'shared-view-manifest', max: 20, windowMs: 60 * 1000 }),
  viewSharedManifest
);

// Separate (higher) bucket: one link can carry many files and "download all"
// fetches each one.
router.get(
  '/:shareId/files/:fileId',
  createRateLimiter({ name: 'shared-view-file', max: 120, windowMs: 60 * 1000 }),
  viewSharedFile
);

module.exports = router;
