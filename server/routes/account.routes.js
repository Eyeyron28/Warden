const express = require('express');

const requireSession = require('../middleware/requireSession');
const createRateLimiter = require('../middleware/rateLimit');
const {
  passwordStart,
  passwordResend,
  passwordConfirm,
  deleteChallenge,
  resendDeleteCode,
  deleteAccount,
  listTrustedDevices,
  removeTrustedDevice,
  removeAllTrustedDevices,
} = require('../controllers/account.controller');
const { getHealth, getPreferences, updatePreferences } = require('../controllers/health.controller');

const router = express.Router();

const byIp = createRateLimiter({ name: 'account-ip', max: 20, windowMs: 60 * 60 * 1000 });
const byAccount = createRateLimiter({
  name: 'account-user',
  max: 10,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.userId ? String(req.userId) : null),
});

router.get('/health', requireSession, getHealth);
router.get('/preferences', requireSession, getPreferences);
router.patch('/preferences', requireSession, updatePreferences);
router.get('/trusted-devices', requireSession, listTrustedDevices);

router.use(byIp, requireSession, byAccount);
router.post('/password/start', passwordStart);
router.post('/password/resend', passwordResend);
router.post('/password/confirm', passwordConfirm);
router.post('/delete-challenge', deleteChallenge);
router.post('/resend-delete-code', resendDeleteCode);
router.delete('/', deleteAccount);
router.delete('/trusted-devices', removeAllTrustedDevices);
router.delete('/trusted-devices/:id', removeTrustedDevice);

module.exports = router;
