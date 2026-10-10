const { isProduction } = require('../runtimeEnv');

/**
 * Emergency Access settings.
 *
 * HONEST SECURITY MODEL (kept here so nobody reads more into it): Warden encrypts uploads on the SERVER, so this is
 * not end-to-end encryption. Emergency Access is a 2-of-2 key split with a time gate: the contact holds half of a
 * key (the kit), the server holds the other half and will use it only after the owner's waiting period ends without
 * a denial. A stolen kit alone, or a leaked database alone, cannot open the vault. A leaked database PLUS the kit
 * can. A malicious operator colluding with the contact can bypass the wait. Folder scope is enforced by the server
 * (policy), not by cryptography.
 *
 *   EMERGENCY_DEMO_MODE   "true" also allows a 2-minute wait. DEMO ONLY: never set it on a real deployment.
 *   EMERGENCY_CLAIM_DAYS  how long after the wait ends the contact can still start a session (default 7, 1 to 30).
 */

const WAIT_OPTIONS_MINUTES = Object.freeze([4320, 10080, 20160]); // 3, 7, 14 days
const DEMO_WAIT_MINUTES = 2;

const demoMode = () => String(process.env.EMERGENCY_DEMO_MODE || '').trim().toLowerCase() === 'true';

/** The waits the owner may choose from right now. */
const allowedWaits = () => (demoMode() ? [DEMO_WAIT_MINUTES, ...WAIT_OPTIONS_MINUTES] : [...WAIT_OPTIONS_MINUTES]);

function claimDays() {
  const raw = String(process.env.EMERGENCY_CLAIM_DAYS ?? '').trim();
  if (raw === '') return 7;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('EMERGENCY_CLAIM_DAYS must be a whole number of days from 1 to 30.');
  return days;
}

/** Called at start-up: a bad value, or the demo switch on a production deployment, must not go unnoticed. */
function assertEmergencyConfig() {
  claimDays();
  if (demoMode() && isProduction()) {
    console.warn('EMERGENCY_DEMO_MODE is true on a production deployment: a 2-minute waiting period can be chosen. Turn it off.');
  }
}

const LIMITS = Object.freeze({
  CONTACT_LABEL_MAX: 60,
  SESSION_ABSOLUTE_MS: 4 * 60 * 60 * 1000, // an emergency session never lasts more than 4 hours
  DENY_COOLDOWN_MS: 24 * 60 * 60 * 1000, // after a denial the contact cannot ask again for 24 hours
  FINISHED_REQUEST_TTL_MS: 90 * 24 * 60 * 60 * 1000,
  OWNER_REMINDER_EVERY_MS: 24 * 60 * 60 * 1000,
  MAX_SCOPE_FOLDERS: 50,
});

module.exports = { WAIT_OPTIONS_MINUTES, DEMO_WAIT_MINUTES, demoMode, allowedWaits, claimDays, assertEmergencyConfig, LIMITS };
