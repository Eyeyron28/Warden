const { isProduction } = require('./runtimeEnv');

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
 *   - In development, if it is unset, links fall back to the local dev server
 *     (https://localhost:5173) and startup logs that this is happening. Nothing
 *     is detected from the network.
 */

const DEV_ORIGIN = 'https://localhost:5173';

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

/** Whether PUBLIC_APP_URL is set (as opposed to the development fallback). */
function publicAppUrlIsConfigured() {
  return Boolean((process.env.PUBLIC_APP_URL || '').trim());
}

/**
 * The origin to build links from: PUBLIC_APP_URL (validated), or in development
 * only the local dev server. In production it is null when unset (startup refuses).
 * @returns {string | null}
 */
function getPublicAppUrl() {
  const raw = (process.env.PUBLIC_APP_URL || '').trim();
  if (raw) return parsePublicAppUrl(raw);
  if (isProduction()) return null;
  return DEV_ORIGIN;
}

/**
 * Validates the configuration (call once at startup).
 * @returns {{ source: 'env' | 'dev', origin: string | null }}
 */
function assertPublicAppUrlConfig() {
  const raw = (process.env.PUBLIC_APP_URL || '').trim();
  if (raw) return { source: 'env', origin: parsePublicAppUrl(raw) };
  if (isProduction()) {
    throw new Error('PUBLIC_APP_URL is required in production (an https origin, e.g. https://warden.example.com).');
  }
  return { source: 'dev', origin: getPublicAppUrl() };
}

/** One line for the startup log saying which source is in use. */
function describePublicAppUrl() {
  const { source, origin } = assertPublicAppUrlConfig();
  return source === 'env'
    ? `Links (share, email) use PUBLIC_APP_URL: ${origin}`
    : `PUBLIC_APP_URL is not set; development fallback in use for links: ${origin}`;
}

module.exports = { assertPublicAppUrlConfig, getPublicAppUrl, publicAppUrlIsConfigured, describePublicAppUrl, parsePublicAppUrl };
