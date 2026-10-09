const crypto = require('crypto');

const Device = require('../models/Device');
const { cookieOptions, hashToken, labelFromUserAgent, readCookie } = require('./trustedDevice');
const { cityFrom, countryFrom } = require('./audit');

/**
 * Which browser is this? A long random id in a strictly functional cookie (`warden_did`, HttpOnly, Secure,
 * SameSite=Strict, 400 days) lets the account's "Devices" list tell its browsers apart and sign one out. It
 * is not used for anything else: no tracking, no advertising, nothing shared with anyone. Only its SHA-256
 * is stored. It is separate from the trusted-browser cookie (a browser can be known without being trusted).
 *
 * The device's label is the coarse "Browser on OS" from the User-Agent (no fingerprinting). Its place is
 * country and city ONLY, from the hosting platform's headers; there is no IP address and no third-party
 * lookup anywhere, and both are empty in local development.
 */
const COOKIE_NAME = 'warden_did';
const MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 60 * 1000;

/**
 * Finds or creates this browser's Device for one account and refreshes the cookie.
 * @returns {Promise<{ device: object, isNew: boolean, hadOtherDevices: boolean }>}
 */
async function resolveDevice(req, res, userId) {
  const existingCookie = readCookie(req, COOKIE_NAME);
  const raw = existingCookie || crypto.randomBytes(32).toString('base64url');
  const deviceIdHash = hashToken(raw);
  const now = new Date();
  const place = { lastCountry: countryFrom(req), lastCity: cityFrom(req) };
  const label = labelFromUserAgent(req.headers?.['user-agent']);

  let device = await Device.findOne({ userId, deviceIdHash });
  let isNew = false;
  let hadOtherDevices = false;
  if (device) {
    await Device.updateOne({ _id: device._id }, { $set: { lastSeenAt: now, label, signedOutAt: null, ...place } });
  } else {
    hadOtherDevices = (await Device.countDocuments({ userId })) > 0;
    device = await Device.create({ userId, deviceIdHash, label, firstSeenAt: now, lastSeenAt: now, trusted: false, signedOutAt: null, ...place });
    isNew = true;
  }

  res.cookie(COOKIE_NAME, raw, { ...cookieOptions(req), maxAge: MAX_AGE_MS });
  return { device, isNew, hadOtherDevices };
}

/** The Device that this request's cookie names for one account, or null (no cookie, or unknown). */
async function deviceFromCookie(req, userId) {
  const raw = readCookie(req, COOKIE_NAME);
  if (!raw) return null;
  return Device.findOne({ userId, deviceIdHash: hashToken(raw) });
}

/** Marks a device as seen (at most once a minute), with its latest place. Cheap enough for every request. */
async function touchDevice(req, deviceId) {
  if (!deviceId) return;
  await Device.updateOne(
    { _id: deviceId, lastSeenAt: { $lt: new Date(Date.now() - TOUCH_EVERY_MS) } },
    { $set: { lastSeenAt: new Date(), lastCountry: countryFrom(req), lastCity: cityFrom(req) } }
  );
}

module.exports = { COOKIE_NAME, MAX_AGE_MS, resolveDevice, deviceFromCookie, touchDevice };
