const crypto = require('crypto');

/**
 * In-memory session store.
 *
 * A session maps a random bearer token to the AES encryption key derived
 * at unlock time. This is deliberately NOT backed by Mongo, a file, or
 * any other persistent store: the encryption key must only ever exist in
 * server RAM for the lifetime of an unlocked session. Persisting it
 * anywhere would mean the key survives a restart (or a disk snapshot),
 * which defeats the point of deriving it fresh from the master password
 * on every unlock. Restarting the server naturally invalidates every
 * session, which is the correct behavior for a vault.
 */

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes, refreshed on each use
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** @type {Map<string, { encryptionKey: Buffer, expiresAt: number }>} */
const sessions = new Map();

/**
 * Creates a new session for a just-derived encryption key and returns its
 * bearer token.
 *
 * @param {Buffer} encryptionKey
 * @returns {string} hex-encoded session token
 */
function createSession(encryptionKey) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { encryptionKey, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

/**
 * Looks up a session by token. Returns `null` if the token is unknown or
 * expired (and evicts it in the latter case).
 *
 * @param {string} token
 * @returns {{ encryptionKey: Buffer, expiresAt: number } | null}
 */
function getSession(token) {
  const session = sessions.get(token);
  if (!session) return null;

  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }

  return session;
}

/**
 * Slides a session's expiry forward from now. Called on every
 * authenticated request so an active user is never logged out mid-use.
 *
 * @param {string} token
 */
function refreshSession(token) {
  const session = sessions.get(token);
  if (!session) return;
  session.expiresAt = Date.now() + SESSION_TTL_MS;
}

/**
 * Ends a session immediately (e.g. explicit lock/logout).
 *
 * @param {string} token
 */
function destroySession(token) {
  sessions.delete(token);
}

// Periodic sweep so idle-but-unused expired sessions don't linger in
// memory indefinitely. `.unref()` keeps this timer from holding the
// Node process open on its own.
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now > session.expiresAt) sessions.delete(token);
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

module.exports = {
  createSession,
  getSession,
  refreshSession,
  destroySession,
};
