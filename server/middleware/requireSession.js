const { getSession, refreshSession } = require('../utils/sessionStore');
const { touchDevice } = require('../utils/deviceIdentity');
const { assertEmergencyAllowed } = require('./emergencyGuard');

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
    error.code = 'SESSION_INVALID';
    throw error;
  }

  const session = await getSession(token);
  if (!session) {
    const error = new Error('Session expired or invalid. Please log in again.');
    error.status = 401;
    error.code = 'SESSION_INVALID';
    throw error;
  }

  // Emergency Access sessions are read-only and deny-by-default: anything off the allowlist is refused here, before
  // any handler runs (middleware/emergencyGuard.js).
  if (session.emergency) assertEmergencyAllowed(req);

  await refreshSession(token, { absoluteExpiresAt: session.absoluteExpiresAt || null });

  req.userId = session.userId;
  req.dek = session.dek;
  // The browser this session belongs to (null for a session made before devices existed).
  req.deviceId = session.deviceId || null;
  // null for a normal session; { scopeMode, scopePaths, readOnly, ... } for an emergency one.
  req.emergency = session.emergency || null;
  req.session = {
    token,
    idHash: session.sessionIdHash,
    encryptionKey: session.dek,
  };
  // "Last active" for the Devices page; written at most once a minute and never allowed to fail a request.
  try {
    await touchDevice(req, req.deviceId);
  } catch {
    // best effort
  }

  next();
});

module.exports = requireSession;
