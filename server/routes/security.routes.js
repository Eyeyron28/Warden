const express = require('express');

const requireSession = require('../middleware/requireSession');
const createRateLimiter = require('../middleware/rateLimit');
const {
  listDevices,
  signOutDevice,
  forgetTrustedDevice,
  signOutOthers,
  listActivity,
  verifyLog,
  clientEvent,
} = require('../controllers/security.controller');

// Devices, the activity log and the log check. Everything needs a signed-in session, and every query is
// scoped to that account: another account's devices and events are never readable. There is deliberately
// NO route that edits or deletes an event.
const router = express.Router();

const byAccount = createRateLimiter({
  name: 'security-user',
  max: 300,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.userId ? String(req.userId) : null),
});

router.use(requireSession, byAccount);
router.get('/devices', listDevices);
router.post('/devices/sign-out-others', signOutOthers);
router.post('/devices/:id/sign-out', signOutDevice);
router.post('/devices/:id/forget-trusted', forgetTrustedDevice);
router.get('/activity', listActivity);
router.post('/verify-log', verifyLog);
router.post('/client-event', clientEvent);

module.exports = router;
