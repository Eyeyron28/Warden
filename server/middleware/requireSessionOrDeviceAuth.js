const { getSession, refreshSession } = require('../utils/sessionStore');
const requireDeviceAuth = require('./requireDeviceAuth');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * For the few routes both a logged-in PC session and a paired phone
 * (deviceToken) may call - currently per-document delete and folder-marker
 * cleanup. Tries the bearer token as a session first (one DB lookup); if
 * that resolves, sets req.userId/req.dek exactly like requireSession does
 * and skips straight to the handler. Otherwise falls through to
 * requireDeviceAuth, which rejects unknown/revoked tokens with the same
 * 401 it always has.
 *
 * (Doesn't simply call requireSession and catch its failure, to avoid
 * doing the session lookup twice - once here to decide, once inside
 * requireSession - for the common case of a real session token.)
 */
const requireSessionOrDeviceAuth = asyncHandler(async (req, res, next) => {
  const [, token] = (req.headers.authorization || '').split(' ');

  if (token) {
    const session = await getSession(token);
    if (session) {
      await refreshSession(token);
      req.userId = session.userId;
      req.dek = session.dek;
      req.session = { token, encryptionKey: session.dek };
      return next();
    }
  }

  return requireDeviceAuth(req, res, next);
});

module.exports = requireSessionOrDeviceAuth;
