const express = require('express');
const { inviteGate } = require('../utils/inviteGate');
const {
  startReset,
  resendResetCode,
  verifyResetCode,
  resetWithRecoveryKey,
  resetWithWipe,
  resetWithRecoveryKeyOnly,
  goneResetLink,
} = require('../controllers/passwordReset.controller');
const router = express.Router();

const {
  signup,
  verifyEmail,
  resendVerification,
  getPublicConfig,
  unlock,
  verifyOtp,
  resendOtp,
  getMe,
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
  // Before the per-email limiter, so a request with no valid code can never
  // use up someone else's per-email allowance.
  inviteGate,
  createRateLimiter({ name: 'signup-email', max: 5, windowMs: 60 * 60 * 1000, keyFn: byEmail }),
  signup
);
router.post(
  '/verify-email',
  createRateLimiter({ name: 'verify-email', max: 20, windowMs: 60 * 60 * 1000 }),
  verifyEmail
);
router.post(
  '/resend-verification',
  createRateLimiter({ name: 'resend-verification-ip', max: 10, windowMs: 60 * 60 * 1000 }),
  // One send per email per 60 seconds. Keyed by the email whether or not
  // an account exists, so the 429 itself never hints at which emails do.
  createRateLimiter({ name: 'resend-verification-email', max: 1, windowMs: 60 * 1000, keyFn: byEmail }),
  resendVerification
);
router.get('/config', getPublicConfig);
router.post(
  '/unlock',
  createRateLimiter({ name: 'login', max: 20, windowMs: 15 * 60 * 1000 }),
  unlock
);
// The code step shares the SAME per-IP bucket as the password step ("login"),
// so every code guess - right or wrong - counts toward the per-IP limit.
router.post(
  '/verify-otp',
  createRateLimiter({ name: 'login', max: 20, windowMs: 15 * 60 * 1000 }),
  verifyOtp
);
router.post(
  '/resend-otp',
  createRateLimiter({ name: 'login', max: 20, windowMs: 15 * 60 * 1000 }),
  resendOtp
);
router.get('/me', requireSession, getMe);
// Forgot password: an emailed 6-digit code, then a single-use ticket, then a
// choice (recovery key, or start over). See controllers/passwordReset.controller.js.
// The start step is limited per IP and per email, and counted the same way for
// addresses that have no account.
router.post(
  '/password-reset/start',
  createRateLimiter({ name: 'password-reset-ip', max: 10, windowMs: 60 * 60 * 1000 }),
  createRateLimiter({ name: 'password-reset-email', max: 5, windowMs: 60 * 60 * 1000, keyFn: byEmail }),
  startReset
);
router.post(
  '/password-reset/resend',
  createRateLimiter({ name: 'password-reset-code-ip', max: 20, windowMs: 15 * 60 * 1000 }),
  resendResetCode
);
router.post(
  '/password-reset/verify',
  createRateLimiter({ name: 'password-reset-code-ip', max: 20, windowMs: 15 * 60 * 1000 }),
  verifyResetCode
);
router.post(
  '/password-reset/with-recovery-key',
  createRateLimiter({ name: 'password-reset-ticket-ip', max: 20, windowMs: 15 * 60 * 1000 }),
  resetWithRecoveryKey
);
router.post(
  '/password-reset/start-over',
  createRateLimiter({ name: 'password-reset-ticket-ip', max: 20, windowMs: 15 * 60 * 1000 }),
  resetWithWipe
);
// "Try another way": the recovery key alone, no email. Its own strict failure
// limits live in the controller (per email and per IP, with growing delays).
router.post('/password-reset/recovery-key-only', resetWithRecoveryKeyOnly);
// The old emailed-link flow is gone; anything still calling it gets a plain 410.
router.post('/forgot-password', goneResetLink);
router.post('/reset-password', goneResetLink);

// None of these take requireSession - recovering access is exactly what
// happens when there's no session to have. /recover-via-phone/submit is
// the one exception, since that request comes from the ALREADY-paired
// phone (authenticated with its own deviceToken), not the locked-out PC.
router.post('/recover-via-phone/init', recoverViaPhoneInit);
router.get('/recover-via-phone/status/:token', recoverViaPhoneStatus);
router.post('/recover-via-phone/submit', requireDeviceAuth, recoverViaPhoneSubmit);
router.post('/recover-via-phone/complete', recoverViaPhoneComplete);

router.post('/logout', requireSession, logout);

module.exports = router;
