const crypto = require('crypto');

const TrustedDevice = require('../models/TrustedDevice');
const Device = require('../models/Device');

// The cookie that makes a browser skip the emailed code after the password ("Trust this browser for 30 days").
//
// ONE COOKIE PER ACCOUNT. It used to be a single cookie named `warden_td`, shared by every account that
// signed in from that browser: trusting the browser for a second account overwrote the first account's
// cookie, and the first account was asked for an emailed code again straight away (the same thing happened
// between a local test database and a deployed one on `localhost`, because cookies ignore ports). Now the
// name carries a short hash of the account id, so each account keeps its own trust. The old name is still
// honoured once and converted, so nobody who was trusted is asked for a code because of this change.
const LEGACY_COOKIE_NAME = 'warden_td';
const COOKIE_PREFIX = 'warden_td_';
const TRUST_DAYS = 30;
const TRUST_MS = TRUST_DAYS * 24 * 60 * 60 * 1000;
// "/api" rather than "/api/auth": login lives under /api/auth but the account list (which marks "this
// browser") is under /api. The cookie never goes to any other path or origin.
const COOKIE_PATH = '/api';

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** The cookie name for one account: `warden_td_` + 16 hex characters of SHA-256(userId). Reveals nothing. */
const cookieNameFor = (userId) => `${COOKIE_PREFIX}${crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 16)}`;

/** Reads one cookie from the Cookie header (there is no cookie-parser). */
function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (typeof header !== 'string' || header.length === 0 || header.length > 8192) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      return /^[A-Za-z0-9_-]{20,128}$/.test(value) ? value : null;
    }
  }
  return null;
}

/** "Chrome on Windows" from the User-Agent - nothing finer, and no IP. */
function labelFromUserAgent(userAgent) {
  const { browser, os } = parseUserAgent(userAgent);
  return `${browser} on ${os}`;
}

/** The browser and operating system named in a User-Agent, coarsely. */
function parseUserAgent(userAgent) {
  const ua = typeof userAgent === 'string' ? userAgent : '';
  let browser = 'Browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\/|CriOS/.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  let os = 'unknown system';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iOS/.test(ua)) os = 'iOS';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return { browser, os };
}

function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    path: COOKIE_PATH,
    // Secure whenever the connection (or the proxy in front of it) is HTTPS, which is every deployment and
    // the mkcert dev server; only a plain-http development server omits it.
    secure: Boolean(req.secure) || process.env.NODE_ENV === 'production',
  };
}

/**
 * Creates the record and sets this account's cookie. The raw token is never stored. Trusting again
 * from the same browser replaces that account's earlier record.
 */
async function trustThisBrowser(req, res, userId, { deviceId = null } = {}) {
  const existing = readCookie(req, cookieNameFor(userId));
  if (existing) await TrustedDevice.deleteMany({ userId, tokenHash: hashToken(existing) });
  if (deviceId) await TrustedDevice.deleteMany({ userId, deviceId });

  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  await TrustedDevice.create({
    userId,
    tokenHash: hashToken(token),
    label: labelFromUserAgent(req.headers?.['user-agent']),
    deviceId,
    createdAt: now,
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + TRUST_MS),
  });
  res.cookie(cookieNameFor(userId), token, { ...cookieOptions(req), maxAge: TRUST_MS });
  if (deviceId) await Device.updateOne({ _id: deviceId, userId }, { $set: { trusted: true } });
}

/**
 * Is this request's cookie a live trust record for THIS user? Anything else (no cookie, malformed,
 * tampered, expired, another account's) is just `false` - the caller falls back to the normal code flow
 * with no hint why. Nothing here looks at the IP address or the User-Agent: a browser update or a new
 * network must not undo trust.
 *
 * A trust cookie from before the per-account names (`warden_td`) is accepted once, and re-issued under
 * the account's own name for the rest of its time (when `res` is given).
 */
async function isTrustedFor(req, userId, res) {
  let token = readCookie(req, cookieNameFor(userId));
  let legacy = false;
  if (!token) {
    token = readCookie(req, LEGACY_COOKIE_NAME);
    legacy = Boolean(token);
  }
  if (!token) return false;

  const record = await TrustedDevice.findOne({ tokenHash: hashToken(token), userId, expiresAt: { $gt: new Date() } });
  if (!record) return false;
  await TrustedDevice.updateOne({ _id: record._id }, { $set: { lastUsedAt: new Date() } });

  if (legacy && res) {
    res.cookie(cookieNameFor(userId), token, { ...cookieOptions(req), maxAge: Math.max(1000, record.expiresAt.getTime() - Date.now()) });
    res.clearCookie(LEGACY_COOKIE_NAME, cookieOptions(req));
  }
  return record;
}

/** Clears one account's trust cookie (and the old shared one, which is never needed again). */
function clearTrustCookie(req, res, userId) {
  if (userId) res.clearCookie(cookieNameFor(userId), cookieOptions(req));
  res.clearCookie(LEGACY_COOKIE_NAME, cookieOptions(req));
}

/** The hash of this request's cookie for this account, to mark "this browser" in a list. */
function currentTokenHash(req, userId) {
  const token = readCookie(req, cookieNameFor(userId)) || readCookie(req, LEGACY_COOKIE_NAME);
  return token ? hashToken(token) : null;
}

/** Every trusted browser of one account (password reset, wipe, deletion...). */
async function revokeAllTrustedDevices(userId) {
  await TrustedDevice.deleteMany({ userId });
  await Device.updateMany({ userId }, { $set: { trusted: false } });
}

module.exports = {
  COOKIE_PREFIX,
  LEGACY_COOKIE_NAME,
  TRUST_MS,
  cookieNameFor,
  cookieOptions,
  hashToken,
  readCookie,
  labelFromUserAgent,
  parseUserAgent,
  trustThisBrowser,
  isTrustedFor,
  clearTrustCookie,
  currentTokenHash,
  revokeAllTrustedDevices,
};
