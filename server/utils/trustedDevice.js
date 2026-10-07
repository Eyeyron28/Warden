const crypto = require('crypto');

const TrustedDevice = require('../models/TrustedDevice');

const COOKIE_NAME = 'warden_td';
const TRUST_DAYS = 30;
const TRUST_MS = TRUST_DAYS * 24 * 60 * 60 * 1000;
// "/api" rather than "/api/auth": login lives under /api/auth but the Account
// page's list (which marks "this browser") is under /api/account. The cookie
// never goes to any other path or origin.
const COOKIE_PATH = '/api';

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** Reads one cookie from the Cookie header (there is no cookie-parser). */
function readCookie(req, name = COOKIE_NAME) {
  const header = req.headers?.cookie;
  if (typeof header !== 'string' || header.length === 0 || header.length > 4096) return null;
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
  return `${browser} on ${os}`;
}

function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    path: COOKIE_PATH,
    // Secure whenever the connection (or the proxy in front of it) is HTTPS,
    // which is every deployment and the mkcert dev server; only a plain-http
    // development server omits it.
    secure: Boolean(req.secure) || process.env.NODE_ENV === 'production',
  };
}

/** Creates the record and sets the cookie. The raw token is never stored. */
async function trustThisBrowser(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  await TrustedDevice.create({
    userId,
    tokenHash: hashToken(token),
    label: labelFromUserAgent(req.headers?.['user-agent']),
    createdAt: now,
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + TRUST_MS),
  });
  res.cookie(COOKIE_NAME, token, { ...cookieOptions(req), maxAge: TRUST_MS });
}

/**
 * Is this request's cookie a live trust record for THIS user? Anything else
 * (no cookie, malformed, tampered, expired, another account's) is just
 * `false` - the caller falls back to the normal code flow with no hint why.
 */
async function isTrustedFor(req, userId) {
  const token = readCookie(req);
  if (!token) return false;
  const record = await TrustedDevice.findOne({
    tokenHash: hashToken(token),
    userId,
    expiresAt: { $gt: new Date() },
  });
  if (!record) return false;
  await TrustedDevice.updateOne({ _id: record._id }, { $set: { lastUsedAt: new Date() } });
  return true;
}

function clearTrustCookie(req, res) {
  res.clearCookie(COOKIE_NAME, cookieOptions(req));
}

/** The hash of this request's cookie, to mark "this browser" in a list. */
function currentTokenHash(req) {
  const token = readCookie(req);
  return token ? hashToken(token) : null;
}

/** Every trusted browser of one account (password reset, wipe, deletion...). */
async function revokeAllTrustedDevices(userId) {
  await TrustedDevice.deleteMany({ userId });
}

module.exports = {
  COOKIE_NAME,
  TRUST_MS,
  hashToken,
  readCookie,
  labelFromUserAgent,
  trustThisBrowser,
  isTrustedFor,
  clearTrustCookie,
  currentTokenHash,
  revokeAllTrustedDevices,
};
