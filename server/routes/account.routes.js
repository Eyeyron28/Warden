const express = require('express');

const requireSession = require('../middleware/requireSession');
const createRateLimiter = require('../middleware/rateLimit');
const { deleteChallenge, resendDeleteCode, deleteAccount } = require('../controllers/account.controller');

const router = express.Router();

// Limited per connection BEFORE the session check (so unauthenticated
// hammering is throttled too) and per account after it. The per-account rows
// are keyed by the account id and are removed with the account.
const byIp = createRateLimiter({ name: 'account-ip', max: 20, windowMs: 60 * 60 * 1000 });
const byAccount = createRateLimiter({
  name: 'account-user',
  max: 10,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.userId ? String(req.userId) : null),
});

router.use(byIp, requireSession, byAccount);
router.post('/delete-challenge', deleteChallenge);
router.post('/resend-delete-code', resendDeleteCode);
router.delete('/', deleteAccount);

module.exports = router;
