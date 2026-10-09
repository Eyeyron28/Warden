/**
 * Document expiry dates (passport, licence, ...). The date is a plain calendar day, stored as that day at
 * 00:00 UTC, and compared by UTC calendar day everywhere (the daily job runs at 01:00 UTC, which is 09:00 in
 * Manila: the same calendar day in both).
 *
 * These dates are stored READABLE by the server (they have to be, to send a reminder when nobody is signed
 * in). The file's contents and name are not part of that.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days before expiry at which a reminder goes out; 0 is the day itself (and any day after it). */
const THRESHOLDS = Object.freeze([60, 30, 7, 0]);
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/** "2027-03-05" -> Date at 00:00 UTC, or null when it is not a real calendar day in a sane range. */
function parseExpiryInput(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

const utcDay = (date) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

/** Whole calendar days from `now` to the expiry day (negative once it has passed). */
function daysUntil(expiresAt, now = new Date()) {
  return Math.round((utcDay(new Date(expiresAt)) - utcDay(now)) / DAY_MS);
}

/** 'expired' (before today), 'soon' (today up to 60 days), or 'ok' / null with no date. */
function expiryStatus(expiresAt, now = new Date()) {
  if (!expiresAt) return null;
  const days = daysUntil(expiresAt, now);
  if (days < 0) return 'expired';
  return days <= THRESHOLDS[0] ? 'soon' : 'ok';
}

/**
 * The reminder that is due for a file `days` from expiry: the SMALLEST threshold already reached (a file set to
 * expire in 6 days is due its "7 days" reminder, not also the 60 and 30 ones). null while more than 60 days off.
 */
function dueThreshold(days) {
  let due = null;
  for (const threshold of THRESHOLDS) if (days <= threshold) due = threshold;
  return due;
}

/** Every threshold at or above the due one: all of these are marked so none can fire later for the same date. */
function thresholdsCovered(due) {
  return due === null ? [] : THRESHOLDS.filter((threshold) => threshold >= due);
}

module.exports = { THRESHOLDS, DAY_MS, parseExpiryInput, daysUntil, expiryStatus, dueThreshold, thresholdsCovered, utcDay };
