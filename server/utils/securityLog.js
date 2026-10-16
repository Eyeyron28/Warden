const crypto = require('crypto');

const { hmacKey } = require('./auditConfig');
const { currentRequestId } = require('./requestContext');

/**
 * Security events for the operator (Vercel Logs). One JSON line per event:
 *   {"type":"lockout","bucket":"login","count":3,"requestId":"a1b2c3d4e5f6","time":"2026-10-15T01:02:03.000Z","subject":"9f8e7d6c"}
 *
 * What a line never holds: an email address, a token, a code, an IP address or a file name. `subject` (optional) is the first
 * eight hex characters of an HMAC (keyed with the activity-log key) of whatever the event is about, so two lines about the same
 * mailbox can be matched without saying whose it is. `count` is a number (attempts, rows, today's mails), never a value.
 */

const EVENTS = new Set([
  'lockout', // a login address reached its failed-attempt limit and is now locked
  'code_failures', // 3 or more wrong guesses on one emailed code
  'rate_limited', // a request was refused with 429 (bucket = the limiter's name)
  'sessions_revoked', // sessions ended by a password reset or "sign out everywhere else" (count = how many)
  'emergency_denied', // the owner denied an Emergency Access request
  'emergency_refused', // an emergency session tried something it may not do, or a request was refused
  'share_password_failures', // wrong passwords on one share link over the threshold
  'mail_cap', // the day's mail budget stopped a send (bucket = priority or bulk, count = the limit that was reached)
  'file_held', // quarantine: an upload was held (bucket = the reason codes, never a name)
  'file_refused', // quarantine: an upload was refused (bucket = the reason codes)
  'file_released', // quarantine: the owner released a held file (bucket = the reason codes)
  'scan_error', // quarantine: the scanner itself failed and the file was saved unchecked (bucket = the error's name)
]);

/** Eight hex characters of a keyed hash: a correlation id, not a way back to the value. */
function keyedId(value) {
  return crypto.createHmac('sha256', hmacKey()).update(`warden-log:${String(value ?? '').trim().toLowerCase()}`).digest('hex').slice(0, 8);
}

// A flood (an attack) must not flood the log: per type and bucket, the first 5 lines each minute, then every 25th.
const seen = new Map();
function allowed(type, bucket, now) {
  const key = `${type}|${bucket}`;
  let entry = seen.get(key);
  if (!entry || now - entry.since > 60 * 1000) {
    entry = { since: now, n: 0 };
    seen.set(key, entry);
  }
  entry.n += 1;
  return entry.n <= 5 || entry.n % 25 === 0;
}

/** Writes one security event. Never throws and never blocks the request. */
function logSecurity(type, { bucket = null, count = null, subject } = {}) {
  try {
    if (!EVENTS.has(type)) return;
    if (!allowed(type, bucket, Date.now())) return;
    const line = { type, bucket, count: Number.isFinite(count) ? count : null, requestId: currentRequestId(), time: new Date().toISOString() };
    if (subject !== undefined && subject !== null) line.subject = keyedId(subject);
    console.warn(JSON.stringify(line));
  } catch {
    // logging must never get in the way
  }
}

/** For tests: forget the flood counters. */
function resetSecurityLogSampling() {
  seen.clear();
}

module.exports = { logSecurity, keyedId, resetSecurityLogSampling, EVENTS };
