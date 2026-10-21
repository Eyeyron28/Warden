const crypto = require('crypto');
const express = require('express');

const { purgeExpired } = require('../utils/trash');
const { runReminders } = require('../utils/reminders');
const { runMaintenance: runEmergencyMaintenance } = require('../utils/emergency/service');
const createRateLimiter = require('../middleware/rateLimit');
const { purgeLegacyUnverified } = require('../utils/legacyCleanup');

const router = express.Router();

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();

function requireCronSecret(req, res, next) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return res.status(404).json({ success: false, error: { message: 'Not found.' } });
  const given = req.get('authorization') || '';
  if (!crypto.timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) {
    return res.status(401).json({ success: false, error: { message: 'Unauthorized.' } });
  }
  return next();
}

const cronLimit = createRateLimiter({ name: 'cron', max: 30, windowMs: 60 * 1000 });

router.get('/purge-trash', cronLimit, requireCronSecret, async (req, res, next) => {
  try {
    const result = await purgeExpired(null);
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.get('/reminders', cronLimit, requireCronSecret, async (req, res, next) => {
  try {
    const result = await runReminders();
    let emergency = null;
    try {
      emergency = await runEmergencyMaintenance();
    } catch (err) {
      console.error('Emergency Access upkeep failed.');
    }
    let legacy = null;
    try {
      legacy = await purgeLegacyUnverified();
    } catch (err) {
      console.error('Legacy sign-up clean-up failed.');
    }
    res.status(200).json({ success: true, ...result, emergency, legacy });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
