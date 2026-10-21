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

const router = express.Router();

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

router.get(
  '/:shareId',
  createRateLimiter({ name: 'shared-view-manifest', max: 20, windowMs: 60 * 1000 }),
  viewSharedManifest
);

router.get(
  '/:shareId/files/:fileId',
  createRateLimiter({ name: 'shared-view-file', max: 120, windowMs: 60 * 1000 }),
  viewSharedFile
);

module.exports = router;
