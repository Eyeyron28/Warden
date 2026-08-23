const { getSession, refreshSession } = require('../utils/sessionStore');

/**
 * Guards routes that need an unlocked vault. Reads a bearer token from the
 * Authorization header, resolves it against the in-memory session store,
 * and attaches the session's encryption key to `req.session` for
 * downstream handlers (e.g. document encrypt/decrypt) to use.
 *
 * A missing or expired session is treated identically - both mean "unlock
 * again" - so this never leaks whether a token merely expired vs. never
 * existed.
 */
function requireSession(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    const error = new Error('Missing or invalid Authorization header.');
    error.status = 401;
    return next(error);
  }

  const session = getSession(token);
  if (!session) {
    const error = new Error('Session expired or invalid. Please unlock the vault again.');
    error.status = 401;
    return next(error);
  }

  refreshSession(token);

  req.session = {
    token,
    encryptionKey: session.encryptionKey,
  };

  next();
}

module.exports = requireSession;
