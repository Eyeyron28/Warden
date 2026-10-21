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

const { signupStart, signupVerify, signupResend, goneSignup } = require('../controllers/signup.controller');
const {
  verifyEmail,
  resendVerification,
  getPublicConfig,
  unlock,
  verifyOtp,
  resendOtp,
  getMe,
  logout,
} = require('../controllers/auth.controller');
const requireSession = require('../middleware/requireSession');
const createRateLimiter = require('../middleware/rateLimit');

const byEmail = (req) => {
  const email = req.body?.email;
  return typeof email === 'string' ? email.trim().toLowerCase() : null;
};

router.post(
  '/signup/start',
  createRateLimiter({ name: 'signup-ip', max: 10, windowMs: 60 * 60 * 1000 }),
  inviteGate,
  createRateLimiter({ name: 'signup-email', max: 5, windowMs: 60 * 60 * 1000, keyFn: byEmail }),
  signupStart
);
router.post('/signup/verify', createRateLimiter({ name: 'signup-verify-ip', max: 30, windowMs: 15 * 60 * 1000 }), signupVerify);
router.post(
  '/signup/resend',
  createRateLimiter({ name: 'signup-resend-ip', max: 10, windowMs: 60 * 60 * 1000 }),
  createRateLimiter({ name: 'signup-resend-email', max: 1, windowMs: 60 * 1000, keyFn: byEmail }),
  signupResend
);
router.post('/signup', goneSignup);
router.post(
  '/verify-email',
  createRateLimiter({ name: 'verify-email', max: 20, windowMs: 60 * 60 * 1000 }),
  verifyEmail
);
router.post(
  '/resend-verification',
  createRateLimiter({ name: 'resend-verification-ip', max: 10, windowMs: 60 * 60 * 1000 }),
  createRateLimiter({ name: 'resend-verification-email', max: 1, windowMs: 60 * 1000, keyFn: byEmail }),
  resendVerification
);
router.get('/config', getPublicConfig);
router.post(
  '/unlock',
  createRateLimiter({ name: 'login', max: 20, windowMs: 15 * 60 * 1000 }),
  unlock
);
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
router.post('/password-reset/recovery-key-only', resetWithRecoveryKeyOnly);
router.post('/forgot-password', goneResetLink);
router.post('/reset-password', goneResetLink);

router.post('/logout', requireSession, logout);

module.exports = router;
