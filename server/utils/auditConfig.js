const { isProduction } = require('./runtimeEnv');

/**
 * Settings for the activity log.
 *   AUDIT_RETENTION_DAYS  how long an event is kept (whole days, 1 to 365; default 30).
 *   AUDIT_HMAC_KEY        the secret that signs the log's hash chain. REQUIRED in production (at least
 *                         32 characters); the server refuses to start without it. Outside production a
 *                         fixed development key is used, so tests and local runs need no setup.
 */
const DEFAULT_RETENTION_DAYS = 30;
const MIN_KEY_LENGTH = 32;
const DEV_KEY = 'warden-development-audit-key-not-for-production';

function retentionDays() {
  const raw = (process.env.AUDIT_RETENTION_DAYS ?? '').trim();
  if (raw === '') return DEFAULT_RETENTION_DAYS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error('AUDIT_RETENTION_DAYS must be a whole number of days from 1 to 365.');
  }
  return days;
}

const retentionMs = () => retentionDays() * 24 * 60 * 60 * 1000;

/** The signing key as a Buffer. Throws in production when it is missing or too short. */
function hmacKey() {
  const configured = (process.env.AUDIT_HMAC_KEY ?? '').trim();
  if (configured.length >= MIN_KEY_LENGTH) return Buffer.from(configured, 'utf8');
  if (isProduction()) throw new Error('AUDIT_HMAC_KEY is required in production (at least 32 characters).');
  return Buffer.from(DEV_KEY, 'utf8');
}

/** Problems with the audit settings, as `{ name, problem }` (names only, never values). */
function auditConfigProblems() {
  const problems = [];
  const key = (process.env.AUDIT_HMAC_KEY ?? '').trim();
  if (!key) problems.push({ name: 'AUDIT_HMAC_KEY', problem: 'missing (it signs the activity log)' });
  else if (key.length < MIN_KEY_LENGTH) problems.push({ name: 'AUDIT_HMAC_KEY', problem: `must be at least ${MIN_KEY_LENGTH} characters` });
  try {
    retentionDays();
  } catch {
    problems.push({ name: 'AUDIT_RETENTION_DAYS', problem: 'must be a whole number of days from 1 to 365' });
  }
  return problems;
}

module.exports = { retentionDays, retentionMs, hmacKey, auditConfigProblems, DEFAULT_RETENTION_DAYS, MIN_KEY_LENGTH };
