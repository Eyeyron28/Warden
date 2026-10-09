const express = require('express');

const requireSession = require('../middleware/requireSession');
const createRateLimiter = require('../middleware/rateLimit');
const {
  requestPairCode,
  resendPairCode,
  initPairing,
  getPairingStatus,
} = require('../controllers/pairing.controller');

// Owner-only, unlike POST /api/pair/complete (routes/pairComplete.routes.js)
// which is mounted at this same /api/pair prefix. requireSession is applied
// per route: a blanket router.use(requireSession) would also run for
// /complete, which has no session.
const router = express.Router();

// Per account, on top of the emailed-code budget (5 mails an hour) and the
// code's own 5 guesses.
const byAccount = createRateLimiter({
  name: 'pair-owner',
  max: 30,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.userId ? String(req.userId) : null),
});

router.post('/code', requireSession, byAccount, requestPairCode);
router.post('/resend-code', requireSession, byAccount, resendPairCode);
router.post('/init', requireSession, byAccount, initPairing);
router.get('/status/:token', requireSession, getPairingStatus);

module.exports = router;
