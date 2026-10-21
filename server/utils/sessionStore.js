const crypto = require('crypto');

const Session = require('../models/Session');
const { wrapKey, unwrapKey } = require('./crypto');
const { revokeAllTrustedDevices } = require('./trustedDevice');
const { logSecurity } = require('./securityLog');

const SESSION_TTL_MS = 30 * 60 * 1000;

const DEFAULT_ABSOLUTE_HOURS = 12;
function sessionAbsoluteHours() {
  const raw = (process.env.SESSION_ABSOLUTE_HOURS ?? '').trim();
  if (raw === '') return DEFAULT_ABSOLUTE_HOURS;
  const hours = Number(raw);
  return Number.isFinite(hours) && hours >= 1 && hours <= 168 ? hours : DEFAULT_ABSOLUTE_HOURS;
}
const sessionAbsoluteMs = () => sessionAbsoluteHours() * 60 * 60 * 1000;
const SESSION_ID_BYTES = 32;
const SESSION_KEY_BYTES = 32;

function hashSessionId(sessionId) {
  return crypto.createHash('sha256').update(sessionId).digest('hex');
}

async function createSession(userId, dek, { deviceId = null, emergency = null } = {}) {
  const sessionId = crypto.randomBytes(SESSION_ID_BYTES).toString('hex');
  const sessionKey = crypto.randomBytes(SESSION_KEY_BYTES);
  const wrapped = wrapKey(dek, sessionKey);

  const now = Date.now();
  const absoluteExpiresAt = emergency ? new Date(now + emergency.absoluteMs) : null;
  await Session.create({
    sessionIdHash: hashSessionId(sessionId),
    userId,
    deviceId: emergency ? null : deviceId,
    createdAt: new Date(now),
    wrappedDEK: wrapped.wrappedKey,
    wrappedDEKIv: wrapped.iv,
    wrappedDEKAuthTag: wrapped.authTag,
    expiresAt: new Date(Math.min(now + SESSION_TTL_MS, absoluteExpiresAt ? absoluteExpiresAt.getTime() : Infinity)),
    ...(emergency
      ? {
          emergency: true,
          accessId: emergency.accessId,
          requestId: emergency.requestId,
          scopeMode: emergency.scopeMode,
          scopePaths: emergency.scopeMode === 'folders' ? emergency.scopePaths || [] : undefined,
          absoluteExpiresAt,
        }
      : {}),
  });

  return `${sessionId}.${sessionKey.toString('hex')}`;
}

function parseToken(token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot === -1) return null;
  const sessionId = token.slice(0, dot);
  const sessionKeyHex = token.slice(dot + 1);
  if (!sessionId || !/^[0-9a-f]+$/i.test(sessionKeyHex)) return null;
  return { sessionId, sessionKey: Buffer.from(sessionKeyHex, 'hex') };
}

async function getSession(token) {
  const parsed = parseToken(token);
  if (!parsed) return null;

  const session = await Session.findOne({ sessionIdHash: hashSessionId(parsed.sessionId) });
  if (!session) return null;

  const absoluteEnd = Math.min(
    session.createdAt ? session.createdAt.getTime() + sessionAbsoluteMs() : Infinity,
    session.absoluteExpiresAt ? session.absoluteExpiresAt.getTime() : Infinity
  );
  const ended = Date.now() > session.expiresAt.getTime() || Date.now() > absoluteEnd;
  if (ended) {
    await Session.deleteOne({ _id: session._id });
    return null;
  }

  let dek;
  try {
    dek = unwrapKey(session.wrappedDEK, parsed.sessionKey, session.wrappedDEKIv, session.wrappedDEKAuthTag);
  } catch {
    return null;
  }

  return {
    userId: session.userId,
    dek,
    deviceId: session.deviceId || null,
    sessionIdHash: session.sessionIdHash,
    absoluteExpiresAt: Number.isFinite(absoluteEnd) ? new Date(absoluteEnd) : null,
    emergency: session.emergency
      ? {
          accessId: session.accessId,
          requestId: session.requestId,
          scopeMode: session.scopeMode || 'all',
          scopePaths: session.scopePaths || [],
          absoluteExpiresAt: session.absoluteExpiresAt,
          readOnly: true,
        }
      : null,
  };
}

async function refreshSession(token, { absoluteExpiresAt = null } = {}) {
  const parsed = parseToken(token);
  if (!parsed) return;
  const slid = new Date(Date.now() + SESSION_TTL_MS);
  const ends = [slid, { $add: ['$createdAt', sessionAbsoluteMs()] }, '$absoluteExpiresAt'];
  if (absoluteExpiresAt) ends.push(new Date(absoluteExpiresAt));
  await Session.updateOne({ sessionIdHash: hashSessionId(parsed.sessionId) }, [{ $set: { expiresAt: { $min: ends } } }]);
}

async function destroySession(token) {
  const parsed = parseToken(token);
  if (!parsed) return;
  await Session.deleteOne({ sessionIdHash: hashSessionId(parsed.sessionId) });
}

async function destroySessionsForDevice(userId, deviceId) {
  const result = await Session.deleteMany({ userId, deviceId });
  return result?.deletedCount ?? 0;
}

async function destroyOtherSessions(userId, keepSessionIdHash) {
  const result = await Session.deleteMany({ userId, sessionIdHash: { $ne: keepSessionIdHash } });
  const count = result?.deletedCount ?? 0;
  if (count > 0) logSecurity('sessions_revoked', { bucket: 'sign-out-others', count });
  return count;
}

async function destroyEmergencySessions(userId) {
  const result = await Session.deleteMany({ userId, emergency: true });
  return result?.deletedCount ?? 0;
}

async function destroyAllSessionsForUser(userId) {
  const gone = await Session.deleteMany({ userId });
  if ((gone?.deletedCount ?? 0) > 0) logSecurity('sessions_revoked', { bucket: 'reset', count: gone.deletedCount });
  await revokeAllTrustedDevices(userId);
}

module.exports = {
  sessionAbsoluteHours,
  createSession,
  getSession,
  refreshSession,
  destroySession,
  destroySessionsForDevice,
  destroyOtherSessions,
  destroyEmergencySessions,
  destroyAllSessionsForUser,
};
