const { isProduction } = require('./runtimeEnv');

/**
 * Email one-time-code (OTP) settings for login.
 *   OTP_ENABLED      defaults to true. Only "false" / "0" turns it off, and
 *                    only outside production: the server refuses to start in
 *                    production with it off (assertOtpConfig, called at
 *                    startup).
 *   OTP_TTL_MINUTES  how long a code (and its login challenge) lasts;
 *                    default 5, whole minutes from 1 to 60.
 */

const DEFAULT_TTL_MINUTES = 5;

function otpEnabled() {
  const raw = (process.env.OTP_ENABLED ?? '').trim().toLowerCase();
  return !(raw === 'false' || raw === '0');
}

function otpTtlMinutes() {
  const raw = (process.env.OTP_TTL_MINUTES ?? '').trim();
  if (raw === '') return DEFAULT_TTL_MINUTES;
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
    throw new Error('OTP_TTL_MINUTES must be a whole number of minutes from 1 to 60.');
  }
  return minutes;
}

/** Throws if the OTP settings are unsafe or malformed. Call once at startup. */
function assertOtpConfig() {
  if (!otpEnabled() && isProduction()) {
    throw new Error('OTP_ENABLED=false is not allowed in production. Remove it (the default is on).');
  }
  otpTtlMinutes();
}

module.exports = { otpEnabled, otpTtlMinutes, assertOtpConfig };
