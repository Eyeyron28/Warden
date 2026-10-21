const crypto = require('crypto');

const Device = require('../models/Device');
const { cookieOptions, hashToken, labelFromUserAgent, readCookie } = require('./trustedDevice');
const { cityFrom, countryFrom } = require('./audit');

const COOKIE_NAME = 'warden_did';
const MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 60 * 1000;

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

async function deviceFromCookie(req, userId) {
  const raw = readCookie(req, COOKIE_NAME);
  if (!raw) return null;
  return Device.findOne({ userId, deviceIdHash: hashToken(raw) });
}

async function touchDevice(req, deviceId) {
  if (!deviceId) return;
  await Device.updateOne(
    { _id: deviceId, lastSeenAt: { $lt: new Date(Date.now() - TOUCH_EVERY_MS) } },
    { $set: { lastSeenAt: new Date(), lastCountry: countryFrom(req), lastCity: cityFrom(req) } }
  );
}

module.exports = { COOKIE_NAME, MAX_AGE_MS, resolveDevice, deviceFromCookie, touchDevice };
