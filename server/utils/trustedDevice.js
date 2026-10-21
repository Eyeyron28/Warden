const crypto = require('crypto');

const TrustedDevice = require('../models/TrustedDevice');
const Device = require('../models/Device');

const LEGACY_COOKIE_NAME = 'warden_td';
const COOKIE_PREFIX = 'warden_td_';
const TRUST_DAYS = 30;
const TRUST_MS = TRUST_DAYS * 24 * 60 * 60 * 1000;
const COOKIE_PATH = '/api';

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const cookieNameFor = (userId) => `${COOKIE_PREFIX}${crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 16)}`;

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

function labelFromUserAgent(userAgent) {
  const { browser, os } = parseUserAgent(userAgent);
  return `${browser} on ${os}`;
}

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
    secure: Boolean(req.secure) || process.env.NODE_ENV === 'production',
  };
}

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

function clearTrustCookie(req, res, userId) {
  if (userId) res.clearCookie(cookieNameFor(userId), cookieOptions(req));
  res.clearCookie(LEGACY_COOKIE_NAME, cookieOptions(req));
}

function currentTokenHash(req, userId) {
  const token = readCookie(req, cookieNameFor(userId)) || readCookie(req, LEGACY_COOKIE_NAME);
  return token ? hashToken(token) : null;
}

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
