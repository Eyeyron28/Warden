const { reserveCapped } = require('../middleware/rateLimit');
const RateLimit = require('../models/RateLimit');
const { logSecurity } = require('./securityLog');

const DEFAULT_CAP = 300;
const DEFAULT_BULK_SHARE = 0.5;
const BUCKET = 'mail-daily';
const WINDOW_MS = 36 * 60 * 60 * 1000;

function mailCap() {
  const raw = (process.env.MAIL_DAILY_CAP ?? '').trim();
  const value = Number(raw);
  return raw !== '' && Number.isInteger(value) && value >= 1 && value <= 100000 ? value : DEFAULT_CAP;
}

function bulkShare() {
  const raw = (process.env.MAIL_BULK_SHARE ?? '').trim();
  const value = Number(raw);
  return raw !== '' && Number.isFinite(value) && value > 0 && value <= 1 ? value : DEFAULT_BULK_SHARE;
}

const bulkLimit = () => Math.max(1, Math.floor(mailCap() * bulkShare()));
const dayKey = (now) => now.toISOString().slice(0, 10);

const reported = new Set();
function reportOnce(mailClass, now, limit) {
  const key = `${dayKey(now)}:${mailClass}`;
  if (reported.has(key)) return;
  reported.clear();
  reported.add(key);
  logSecurity('mail_cap', { bucket: mailClass, count: limit });
}

async function reserveMail(mailClass = 'priority', { now = new Date() } = {}) {
  const max = mailClass === 'bulk' ? bulkLimit() : mailCap();
  try {
    const ok = await reserveCapped({ name: BUCKET, key: dayKey(now), max, windowMs: WINDOW_MS });
    if (!ok) reportOnce(mailClass, now, max);
    return ok;
  } catch {
    return true;
  }
}

async function bulkMailOpen({ now = new Date() } = {}) {
  try {
    const row = await RateLimit.findOne({ bucket: BUCKET, key: dayKey(now) }).lean();
    return !row || row.count < bulkLimit();
  } catch {
    return true;
  }
}

async function mailSentToday({ now = new Date() } = {}) {
  const row = await RateLimit.findOne({ bucket: BUCKET, key: dayKey(now) }).lean();
  return row?.count ?? 0;
}

const resetMailReports = () => reported.clear();

module.exports = { reserveMail, bulkMailOpen, mailSentToday, mailCap, bulkShare, bulkLimit, resetMailReports, BUCKET };
