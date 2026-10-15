const { reserveCapped } = require('../middleware/rateLimit');
const RateLimit = require('../models/RateLimit');
const { logSecurity } = require('./securityLog');

/**
 * A daily budget for outgoing mail, so that sign-up, reminder and notice mail can never use up the provider's daily limit
 * (a free Gmail account allows a few hundred a day) and leave real login codes with nothing to send them.
 *
 *   MAIL_DAILY_CAP    the most mails sent per UTC day by the whole deployment (default 300).
 *   MAIL_BULK_SHARE   the share of that cap bulk mail may use (default 0.5). Bulk mail stops at CAP * SHARE; priority mail
 *                     (login codes, codes for sensitive actions, password-reset codes and security notices) goes on up to CAP.
 *
 * ONE counter row per day in the existing RateLimit collection, so every serverless instance shares it. The counter moves
 * with one atomic conditional update (middleware/rateLimit.js reserveCapped): a send that would pass its threshold does not
 * count, so refused bulk mail never eats the headroom kept for priority mail. Only counts are logged, never an address.
 */

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
  reported.clear(); // one day at a time is enough
  reported.add(key);
  logSecurity('mail_cap', { bucket: mailClass, count: limit });
}

/**
 * Reserves one send. Returns true when it may go ahead. A problem with the counter itself lets the mail through: a login code
 * must not be lost because a bookkeeping write failed.
 */
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

/** Whether bulk mail still has room today, without using any of it (a read). Used to refuse a sign-up start up front. */
async function bulkMailOpen({ now = new Date() } = {}) {
  try {
    const row = await RateLimit.findOne({ bucket: BUCKET, key: dayKey(now) }).lean();
    return !row || row.count < bulkLimit();
  } catch {
    return true;
  }
}

/** Today's total, for reports and tests. */
async function mailSentToday({ now = new Date() } = {}) {
  const row = await RateLimit.findOne({ bucket: BUCKET, key: dayKey(now) }).lean();
  return row?.count ?? 0;
}

/** For tests: forget which day was already reported. */
const resetMailReports = () => reported.clear();

module.exports = { reserveMail, bulkMailOpen, mailSentToday, mailCap, bulkShare, bulkLimit, resetMailReports, BUCKET };
