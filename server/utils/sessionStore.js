const crypto = require('crypto');

const Session = require('../models/Session');
const { wrapKey, unwrapKey } = require('./crypto');

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
 * @returns {Promise<string>} bearer token, `sessionId.sessionKey`
 */
async function createSession(userId, dek) {
  const sessionId = crypto.randomBytes(SESSION_ID_BYTES).toString('hex');
  const sessionKey = crypto.randomBytes(SESSION_KEY_BYTES);
  const wrapped = wrapKey(dek, sessionKey);

  await Session.create({
    sessionIdHash: hashSessionId(sessionId),
    userId,
    wrappedDEK: wrapped.wrappedKey,
    wrappedDEKIv: wrapped.iv,
    wrappedDEKAuthTag: wrapped.authTag,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
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
 * @returns {Promise<{ userId: import('mongoose').Types.ObjectId, dek: Buffer } | null>}
 */
async function getSession(token) {
  const parsed = parseToken(token);
  if (!parsed) return null;

  const session = await Session.findOne({ sessionIdHash: hashSessionId(parsed.sessionId) });
  if (!session) return null;

  if (Date.now() > session.expiresAt.getTime()) {
    await Session.deleteOne({ _id: session._id });
    return null;
  }

  let dek;
  try {
    dek = unwrapKey(session.wrappedDEK, parsed.sessionKey, session.wrappedDEKIv, session.wrappedDEKAuthTag);
  } catch {
    return null;
  }

  return { userId: session.userId, dek };
}

/**
 * Slides a session's expiry forward from now. Called on every
 * authenticated request so an active user is never logged out mid-use.
 *
 * @param {string} token
 */
async function refreshSession(token) {
  const parsed = parseToken(token);
  if (!parsed) return;
  await Session.updateOne(
    { sessionIdHash: hashSessionId(parsed.sessionId) },
    { $set: { expiresAt: new Date(Date.now() + SESSION_TTL_MS) } }
  );
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
 * Deletes every session belonging to one account - called after a
 * password reset (POST /api/auth/reset-password) so a stolen session
 * token from before the reset stops working immediately, same spirit as
 * destroySession but for every device at once rather than just the
 * caller's own.
 *
 * @param {import('mongoose').Types.ObjectId | string} userId
 */
async function destroyAllSessionsForUser(userId) {
  await Session.deleteMany({ userId });
}

module.exports = {
  createSession,
  getSession,
  refreshSession,
  destroySession,
  destroyAllSessionsForUser,
};
