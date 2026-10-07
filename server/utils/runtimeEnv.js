/**
 * Whether this process is running as a production deployment: NODE_ENV is
 * "production", or it is running on Vercel. Several safety checks (required
 * PUBLIC_APP_URL, OTP cannot be disabled, no email bodies in the console)
 * key off this one definition.
 */
function isProduction() {
  return process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
}

module.exports = { isProduction };
