const { isProduction } = require('../runtimeEnv');

const WAIT_OPTIONS_MINUTES = Object.freeze([4320, 10080, 20160]);
const DEMO_WAIT_MINUTES = 2;

const demoMode = () => String(process.env.EMERGENCY_DEMO_MODE || '').trim().toLowerCase() === 'true';

const allowedWaits = () => (demoMode() ? [DEMO_WAIT_MINUTES, ...WAIT_OPTIONS_MINUTES] : [...WAIT_OPTIONS_MINUTES]);

function claimDays() {
  const raw = String(process.env.EMERGENCY_CLAIM_DAYS ?? '').trim();
  if (raw === '') return 7;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('EMERGENCY_CLAIM_DAYS must be a whole number of days from 1 to 30.');
  return days;
}

function assertEmergencyConfig() {
  claimDays();
  if (demoMode() && isProduction()) {
    console.warn('EMERGENCY_DEMO_MODE is true on a production deployment: a 2-minute waiting period can be chosen. Turn it off.');
  }
}

const LIMITS = Object.freeze({
  CONTACT_LABEL_MAX: 60,
  SESSION_ABSOLUTE_MS: 4 * 60 * 60 * 1000,
  DENY_COOLDOWN_MS: 24 * 60 * 60 * 1000,
  FINISHED_REQUEST_TTL_MS: 90 * 24 * 60 * 60 * 1000,
  OWNER_REMINDER_EVERY_MS: 24 * 60 * 60 * 1000,
  MAX_SCOPE_FOLDERS: 50,
});

module.exports = { WAIT_OPTIONS_MINUTES, DEMO_WAIT_MINUTES, demoMode, allowedWaits, claimDays, assertEmergencyConfig, LIMITS };
