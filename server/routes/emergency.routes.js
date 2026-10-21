const express = require('express');

const requireSession = require('../middleware/requireSession');
const createRateLimiter = require('../middleware/rateLimit');
const c = require('../controllers/emergency.controller');

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
const readsByAccount = createRateLimiter({
  name: 'emergency-owner-read',
  max: 600,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.userId ? String(req.userId) : null),
});
ownerRouter.get('/status', requireSession, readsByAccount, c.status);
ownerRouter.get('/session-info', requireSession, readsByAccount, c.sessionInfo);
ownerRouter.get('/folders', requireSession, readsByAccount, c.folderChoices);

ownerRouter.use(requireSession, byAccount);
ownerRouter.post('/challenge', c.startCode);
ownerRouter.post('/challenge/resend', c.resendCode);
ownerRouter.post('/setup', c.setup);
ownerRouter.post('/regenerate-kit', c.regenerateKit);
ownerRouter.post('/revoke', c.revoke);
ownerRouter.post('/requests/:id/deny', c.denyRequest);
ownerRouter.post('/requests/:id/approve-now', c.approveNow);

module.exports = { publicRouter, ownerRouter };
