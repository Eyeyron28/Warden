const { getSession, refreshSession } = require('../utils/sessionStore');
const { touchDevice } = require('../utils/deviceIdentity');
const { assertEmergencyAllowed } = require('./emergencyGuard');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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

  if (session.emergency) assertEmergencyAllowed(req);

  await Promise.all([
    refreshSession(token, { absoluteExpiresAt: session.absoluteExpiresAt || null }),
    Promise.resolve()
      .then(() => touchDevice(req, session.deviceId || null))
      .catch(() => {}),
  ]);

  req.userId = session.userId;
  req.dek = session.dek;
  req.deviceId = session.deviceId || null;
  req.emergency = session.emergency || null;
  req.session = {
    token,
    idHash: session.sessionIdHash,
    encryptionKey: session.dek,
  };
  next();
});

module.exports = requireSession;
