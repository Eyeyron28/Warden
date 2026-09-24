const { getSession } = require('../utils/sessionStore');
const requireSession = require('./requireSession');
const requireDeviceAuth = require('./requireDeviceAuth');

/**
 * For the few routes both the PC (session token) and a paired phone
 * (deviceToken) may call - currently just DELETE /api/documents/:id. Picks
 * the matching guard by whether the bearer token is a live session; anything
 * else goes to requireDeviceAuth, which rejects unknown/revoked tokens with
 * the same 401 it always has.
 */
function requireSessionOrDeviceAuth(req, res, next) {
  const [, token] = (req.headers.authorization || '').split(' ');
  if (token && getSession(token)) return requireSession(req, res, next);
  return requireDeviceAuth(req, res, next);
}

module.exports = requireSessionOrDeviceAuth;
