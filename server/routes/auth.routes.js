const express = require('express');
const router = express.Router();

const {
  getStatus,
  setup,
  unlock,
  recover,
  recoverViaUsb,
  recoverViaPhoneInit,
  recoverViaPhoneStatus,
  recoverViaPhoneSubmit,
  recoverViaPhoneComplete,
  logout,
} = require('../controllers/auth.controller');
const requireSession = require('../middleware/requireSession');
const requireDeviceAuth = require('../middleware/requireDeviceAuth');

router.get('/status', getStatus);
router.post('/setup', setup);
router.post('/unlock', unlock);
router.post('/recover', recover);

// Neither of these takes requireSession - same reasoning as /recover
// itself: recovering access is exactly what happens when there's no
// session to have. /recover-via-phone/submit is the one exception, since
// that request comes from the ALREADY-paired phone (authenticated with
// its own deviceToken), not the locked-out PC.
router.post('/recover-via-usb', recoverViaUsb);
router.post('/recover-via-phone/init', recoverViaPhoneInit);
router.get('/recover-via-phone/status/:token', recoverViaPhoneStatus);
router.post('/recover-via-phone/submit', requireDeviceAuth, recoverViaPhoneSubmit);
router.post('/recover-via-phone/complete', recoverViaPhoneComplete);

router.post('/logout', requireSession, logout);

module.exports = router;
