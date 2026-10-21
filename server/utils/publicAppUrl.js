const { isProduction } = require('./runtimeEnv');

const DEV_ORIGIN = 'https://localhost:5173';

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

function publicAppUrlIsConfigured() {
  return Boolean((process.env.PUBLIC_APP_URL || '').trim());
}

function getPublicAppUrl() {
  const raw = (process.env.PUBLIC_APP_URL || '').trim();
  if (raw) return parsePublicAppUrl(raw);
  if (isProduction()) return null;
  return DEV_ORIGIN;
}

function assertPublicAppUrlConfig() {
  const raw = (process.env.PUBLIC_APP_URL || '').trim();
  if (raw) return { source: 'env', origin: parsePublicAppUrl(raw) };
  if (isProduction()) {
    throw new Error('PUBLIC_APP_URL is required in production (an https origin, e.g. https://warden.example.com).');
  }
  return { source: 'dev', origin: getPublicAppUrl() };
}

function describePublicAppUrl() {
  const { source, origin } = assertPublicAppUrlConfig();
  return source === 'env'
    ? `Links (share, email) use PUBLIC_APP_URL: ${origin}`
    : `PUBLIC_APP_URL is not set; development fallback in use for links: ${origin}`;
}

module.exports = { assertPublicAppUrlConfig, getPublicAppUrl, publicAppUrlIsConfigured, describePublicAppUrl, parsePublicAppUrl };
