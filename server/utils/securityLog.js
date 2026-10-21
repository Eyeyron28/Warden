const crypto = require('crypto');

const { hmacKey } = require('./auditConfig');
const { currentRequestId } = require('./requestContext');

const EVENTS = new Set([
  'lockout',
  'code_failures',
  'rate_limited',
  'sessions_revoked',
  'emergency_denied',
  'emergency_refused',
  'share_password_failures',
  'mail_cap',
  'file_held',
  'file_refused',
  'file_released',
  'document_limit',
  'scan_error',
]);

function keyedId(value) {
  return crypto.createHmac('sha256', hmacKey()).update(`warden-log:${String(value ?? '').trim().toLowerCase()}`).digest('hex').slice(0, 8);
}

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

function logSecurity(type, { bucket = null, count = null, subject } = {}) {
  try {
    if (!EVENTS.has(type)) return;
    if (!allowed(type, bucket, Date.now())) return;
    const line = { type, bucket, count: Number.isFinite(count) ? count : null, requestId: currentRequestId(), time: new Date().toISOString() };
    if (subject !== undefined && subject !== null) line.subject = keyedId(subject);
    console.warn(JSON.stringify(line));
  } catch {
  }
}

function resetSecurityLogSampling() {
  seen.clear();
}

module.exports = { logSecurity, keyedId, resetSecurityLogSampling, EVENTS };
