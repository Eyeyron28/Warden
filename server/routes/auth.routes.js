const express = require('express');
const router = express.Router();

const {
  signup,
  verifyEmail,
  unlock,
  getMe,
  forgotPassword,
  resetPassword,
  recoverViaUsb,
  recoverViaPhoneInit,
  recoverViaPhoneStatus,
  recoverViaPhoneSubmit,
  recoverViaPhoneComplete,
  logout,
} = require('../controllers/auth.controller');
const requireSession = require('../middleware/requireSession');
const requireDeviceAuth = require('../middleware/requireDeviceAuth');
const createRateLimiter = require('../middleware/rateLimit');

// Per-email key for the two limiters that also count by email (signup,
// forgot-password) - a missing/non-string email just means "no extra
// per-email limiting for this request," the controller's own validation
// rejects it on different grounds right after.
const byEmail = (req) => {
  const email = req.body?.email;
  return typeof email === 'string' ? email.trim().toLowerCase() : null;
};

router.post(
  '/signup',
  createRateLimiter({ name: 'signup-ip', max: 10, windowMs: 60 * 60 * 1000 }),
  createRateLimiter({ name: 'signup-email', max: 5, windowMs: 60 * 60 * 1000, keyFn: byEmail }),
  signup
);
router.post(
  '/verify-email',
  createRateLimiter({ name: 'verify-email', max: 20, windowMs: 60 * 60 * 1000 }),
  verifyEmail
);
router.post(
  '/unlock',
  createRateLimiter({ name: 'login', max: 20, windowMs: 15 * 60 * 1000 }),
  unlock
);
router.get('/me', requireSession, getMe);
router.post(
  '/forgot-password',
  createRateLimiter({ name: 'forgot-password-ip', max: 10, windowMs: 60 * 60 * 1000 }),
  createRateLimiter({ name: 'forgot-password-email', max: 5, windowMs: 60 * 60 * 1000, keyFn: byEmail }),
  forgotPassword
);
router.post('/reset-password', resetPassword);

// None of these take requireSession - recovering access is exactly what
// happens when there's no session to have. /recover-via-phone/submit is
// the one exception, since that request comes from the ALREADY-paired
// phone (authenticated with its own deviceToken), not the locked-out PC.
router.post('/recover-via-usb', recoverViaUsb);
router.post('/recover-via-phone/init', recoverViaPhoneInit);
router.get('/recover-via-phone/status/:token', recoverViaPhoneStatus);
router.post('/recover-via-phone/submit', requireDeviceAuth, recoverViaPhoneSubmit);
router.post('/recover-via-phone/complete', recoverViaPhoneComplete);

router.post('/logout', requireSession, logout);

module.exports = router;
