const crypto = require('crypto');

const Session = require('../models/Session');
const { wrapKey, unwrapKey } = require('./crypto');
const { revokeAllTrustedDevices } = require('./trustedDevice');

/**
 * DB-backed session store, replacing the old in-memory Map. A single
 * long-lived Node process could safely hold the unwrapped DEK in RAM for
 * the life of a session; a serverless deployment has no such process -
 * every request may land on a different instance - so the session itself
 * has to live in Mongo. See models/Session.js for exactly what is and
 * isn't persisted.
 *
 * The bearer token handed to the client is `${sessionId}.${sessionKey}`,
 * both hex. sessionId identifies the Session document (by the SHA-256 of
 * itself, never in plain form); sessionKey is the AES-256-GCM key the
 * DEK is wrapped under and is NEVER stored anywhere - it only ever exists
 * inside the bearer token itself, so a database compromise alone (without
 * a client's actual bearer token) cannot unwrap any account's DEK.
 *
 * Same 30-minute sliding expiry as the in-memory store it replaces:
 * refreshSession bumps expiresAt forward on every authenticated request,
 * same as before - "sliding," not fixed.
 */

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes, refreshed on each use
const SESSION_ID_BYTES = 32;
const SESSION_KEY_BYTES = 32; // AES-256

function hashSessionId(sessionId) {
  return crypto.createHash('sha256').update(sessionId).digest('hex');
}

/**
 * Creates a new session for a just-unwrapped DEK and returns its bearer
 * token.
 *
 * @param {import('mongoose').Types.ObjectId | string} userId
 * @param {Buffer} dek
 * @param {{ deviceId?: any, emergency?: { accessId: any, requestId: any, scopeMode: 'all'|'folders', scopePaths?: string[], absoluteMs: number } }} [options]
 *   deviceId: the browser (models/Device.js) this session belongs to.
 *   emergency: makes it an Emergency Access session (read-only, scoped, never longer than absoluteMs). This is still
 *   the ONE function that creates a session; nothing else writes Session rows.
 * @returns {Promise<string>} bearer token, `sessionId.sessionKey`
 */
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

/**
 * Parses a bearer token into its two halves, or null if it isn't
 * shaped like one at all (no DB lookup needed for that case).
 */
function parseToken(token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot === -1) return null;
  const sessionId = token.slice(0, dot);
  const sessionKeyHex = token.slice(dot + 1);
  if (!sessionId || !/^[0-9a-f]+$/i.test(sessionKeyHex)) return null;
  return { sessionId, sessionKey: Buffer.from(sessionKeyHex, 'hex') };
}

/**
 * Looks up a session by bearer token and unwraps its DEK. Returns `null`
 * if the token is malformed, unknown, expired (the TTL index will reap it
 * from Mongo shortly after, but a request can race that by a moment), or
 * if the wrap fails to unwrap (a sessionKey that doesn't match what this
 * session was created with, which can only mean a forged/corrupted token
 * since a real one always carries its own matching key).
 *
 * @param {string} token
 * @returns {Promise<{ userId: import('mongoose').Types.ObjectId, dek: Buffer, deviceId: any, sessionIdHash: string } | null>}
 */
async function getSession(token) {
  const parsed = parseToken(token);
  if (!parsed) return null;

  const session = await Session.findOne({ sessionIdHash: hashSessionId(parsed.sessionId) });
  if (!session) return null;

  // An emergency session also has an absolute end that sliding refreshes can never push past.
  const ended = Date.now() > session.expiresAt.getTime() || (session.absoluteExpiresAt && Date.now() > session.absoluteExpiresAt.getTime());
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

/**
 * Slides a session's expiry forward from now. Called on every
 * authenticated request so an active user is never logged out mid-use.
 *
 * @param {string} token
 */
async function refreshSession(token, { absoluteExpiresAt = null } = {}) {
  const parsed = parseToken(token);
  if (!parsed) return;
  const slid = Date.now() + SESSION_TTL_MS;
  const next = absoluteExpiresAt ? Math.min(slid, new Date(absoluteExpiresAt).getTime()) : slid;
  await Session.updateOne({ sessionIdHash: hashSessionId(parsed.sessionId) }, { $set: { expiresAt: new Date(next) } });
}

/**
 * Ends a session immediately (e.g. explicit lock/logout) by deleting its
 * document outright, rather than leaving it to expire on its own - this is
 * what makes "Lock vault" a real security boundary instead of just a UI
 * state change.
 *
 * @param {string} token
 */
async function destroySession(token) {
  const parsed = parseToken(token);
  if (!parsed) return;
  await Session.deleteOne({ sessionIdHash: hashSessionId(parsed.sessionId) });
}

/**
 * Signs one browser out: every session that belongs to this device.
 * @returns {Promise<number>} how many sessions were removed
 */
async function destroySessionsForDevice(userId, deviceId) {
  const result = await Session.deleteMany({ userId, deviceId });
  return result?.deletedCount ?? 0;
}

/**
 * Signs out every session of the account EXCEPT the one with this id hash (the caller's own).
 * @returns {Promise<number>} how many sessions were removed
 */
async function destroyOtherSessions(userId, keepSessionIdHash) {
  const result = await Session.deleteMany({ userId, sessionIdHash: { $ne: keepSessionIdHash } });
  return result?.deletedCount ?? 0;
}

/**
 * Ends every Emergency Access session of an account at once (revoke, a new kit, a request that ended, a changed
 * vault key). Normal login sessions are untouched.
 * @returns {Promise<number>}
 */
async function destroyEmergencySessions(userId) {
  const result = await Session.deleteMany({ userId, emergency: true });
  return result?.deletedCount ?? 0;
}

/**
 * Deletes every session belonging to one account - called after a
 * password reset (utils/accountReset.js finishReset) so a stolen session
 * token from before the reset stops working immediately, same spirit as
 * destroySession but for every device at once rather than just the
 * caller's own.
 *
 * @param {import('mongoose').Types.ObjectId | string} userId
 */
async function destroyAllSessionsForUser(userId) {
  await Session.deleteMany({ userId });
  // Trusted browsers go with the sessions: a password reset or vault wipe must
  // not leave a device that still skips the emailed code.
  await revokeAllTrustedDevices(userId);
}

module.exports = {
  createSession,
  getSession,
  refreshSession,
  destroySession,
  destroySessionsForDevice,
  destroyOtherSessions,
  destroyEmergencySessions,
  destroyAllSessionsForUser,
};
