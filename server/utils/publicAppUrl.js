const { resolveLanIp } = require('./network');

/**
 * The one place the app decides which origin links it hands out (share
 * links, verification and reset emails) point at.
 *
 * Never built from request headers: Host and X-Forwarded-Host are chosen by
 * whoever sends the request, so a link built from them could be pointed at an
 * attacker's server. Instead:
 *   - PUBLIC_APP_URL, when set, is the answer. It must be an https origin: no
 *     path, no query or fragment, no userinfo. Checked at startup.
 *   - In production (NODE_ENV=production or running on Vercel) it is required.
 *   - In development, if it is unset, the links fall back to this machine's
 *     LAN IP on the Vite dev port, and startup logs that this is happening.
 */

const DEV_FRONTEND_PORT = 5173;

function isProduction() {
  return process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
}

/** Returns the validated origin for a raw PUBLIC_APP_URL, or throws. */
function parsePublicAppUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PUBLIC_APP_URL is not a valid URL. Use an https origin such as https://warden.example.com.');
  }
  if (url.protocol !== 'https:') {
    throw new Error('PUBLIC_APP_URL must use https.');
  }
  if (url.username || url.password) {
    throw new Error('PUBLIC_APP_URL must not contain a username or password.');
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('PUBLIC_APP_URL must be just an origin: no path, query or fragment.');
  }
  return url.origin;
}

/**
 * The origin to build links from, or null if none can be determined (dev
 * with no PUBLIC_APP_URL and no detectable LAN IP).
 * @returns {string | null}
 */
function getPublicAppUrl() {
  const raw = (process.env.PUBLIC_APP_URL || '').trim();
  if (raw) return parsePublicAppUrl(raw);
  if (isProduction()) return null;
  const lanIp = resolveLanIp();
  // https because the local dev servers are https (mkcert); never taken from
  // the incoming request.
  return lanIp ? `https://${lanIp}:${DEV_FRONTEND_PORT}` : null;
}

/**
 * Validates the configuration (call once at startup).
 * @returns {{ source: 'env' | 'lan', origin: string | null }}
 */
function assertPublicAppUrlConfig() {
  const raw = (process.env.PUBLIC_APP_URL || '').trim();
  if (raw) return { source: 'env', origin: parsePublicAppUrl(raw) };
  if (isProduction()) {
    throw new Error('PUBLIC_APP_URL is required in production (an https origin, e.g. https://warden.example.com).');
  }
  return { source: 'lan', origin: getPublicAppUrl() };
}

/** One line for the startup log saying which source is in use. */
function describePublicAppUrl() {
  const { source, origin } = assertPublicAppUrlConfig();
  return source === 'env'
    ? `Links (share, email) use PUBLIC_APP_URL: ${origin}`
    : `PUBLIC_APP_URL is not set; development fallback in use for links: ${origin || 'no LAN IP detected'}`;
}

module.exports = { assertPublicAppUrlConfig, getPublicAppUrl, describePublicAppUrl, parsePublicAppUrl };
