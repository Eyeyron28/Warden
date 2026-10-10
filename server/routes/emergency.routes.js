const express = require('express');

const requireSession = require('../middleware/requireSession');
const createRateLimiter = require('../middleware/rateLimit');
const c = require('../controllers/emergency.controller');

/**
 * Emergency Access (security model: utils/emergency/config.js).
 *
 * Two routers, mounted in server.js: `publicRouter` at /api/emergency/public (a trusted contact has NO account: strict
 * limits per connection, every answer neutral) and `ownerRouter` at /api/emergency (a signed-in, normal session; an
 * emergency session is refused for every one of these by the guard in requireSession).
 */

const publicRouter = express.Router();
const byIp = createRateLimiter({ name: 'emergency-public-ip', max: 40, windowMs: 60 * 60 * 1000 });
publicRouter.use(byIp);
publicRouter.post('/request-code', c.requestCode);
publicRouter.post('/request', c.request);
publicRouter.post('/start-session', c.startSession);
publicRouter.get('/deny/:token', c.denyByToken);

const ownerRouter = express.Router();
const byAccount = createRateLimiter({
  name: 'emergency-owner',
  max: 60,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.userId ? String(req.userId) : null),
});
ownerRouter.use(requireSession, byAccount);
ownerRouter.get('/status', c.status);
ownerRouter.post('/challenge', c.startCode);
ownerRouter.post('/challenge/resend', c.resendCode);
ownerRouter.post('/setup', c.setup);
ownerRouter.post('/regenerate-kit', c.regenerateKit);
ownerRouter.post('/revoke', c.revoke);
ownerRouter.post('/requests/:id/deny', c.denyRequest);
ownerRouter.post('/requests/:id/approve-now', c.approveNow);

module.exports = { publicRouter, ownerRouter };
