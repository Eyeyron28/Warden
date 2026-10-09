const crypto = require('crypto');
const express = require('express');

const { purgeExpired } = require('../utils/trash');
const { runReminders } = require('../utils/reminders');

const router = express.Router();

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();

// Vercel Cron calls this with `Authorization: Bearer <CRON_SECRET>` (it sends
// the project's CRON_SECRET variable automatically). Without CRON_SECRET the
// endpoint does not exist, so nothing can be triggered anonymously; the purge
// still happens opportunistically on each account's own requests.
function requireCronSecret(req, res, next) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return res.status(404).json({ success: false, error: { message: 'Not found.' } });
  const given = req.get('authorization') || '';
  if (!crypto.timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) {
    return res.status(401).json({ success: false, error: { message: 'Unauthorized.' } });
  }
  return next();
}

// Safe to run twice or not at all (Vercel cron delivery is best effort): it
// only removes Trash items whose 30 days are already over.
router.get('/purge-trash', requireCronSecret, async (req, res, next) => {
  try {
    const result = await purgeExpired(null);
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// Daily at 01:00 UTC (09:00 in Manila): one email per account that has documents due a reminder, merged.
// Idempotent (a reminder is claimed in the database before it is sent), bounded in time and in emails per run,
// and it returns counts only.
router.get('/reminders', requireCronSecret, async (req, res, next) => {
  try {
    const result = await runReminders();
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
