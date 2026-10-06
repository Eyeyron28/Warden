const { getSession, refreshSession } = require('../utils/sessionStore');

// Routes are async, but Express doesn't forward rejected promises to
// error-handling middleware on its own - this small wrapper does that so
// this handler can just `throw` instead of a try/catch.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Guards routes that need a logged-in account. Reads a bearer token from
 * the Authorization header, resolves it against the DB-backed session
 * store (utils/sessionStore.js), and sets req.userId plus req.dek - the
 * account's DEK, unwrapped fresh for this one request and never written
 * anywhere - for downstream handlers to use.
 *
 * req.session.encryptionKey is also set, mirroring req.dek, purely so
 * every controller written against the old in-memory session shape keeps
 * working unchanged; new code should read req.dek/req.userId directly.
 *
 * A missing or expired session is treated identically - both mean "log in
 * again" - so this never leaks whether a token merely expired vs. never
 * existed.
 */
const requireSession = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    const error = new Error('Missing or invalid Authorization header.');
    error.status = 401;
    throw error;
  }

  const session = await getSession(token);
  if (!session) {
    const error = new Error('Session expired or invalid. Please log in again.');
    error.status = 401;
    throw error;
  }

  await refreshSession(token);

  req.userId = session.userId;
  req.dek = session.dek;
  req.session = {
    token,
    encryptionKey: session.dek,
  };

  next();
});

module.exports = requireSession;
