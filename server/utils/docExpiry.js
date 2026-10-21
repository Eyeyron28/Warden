const DAY_MS = 24 * 60 * 60 * 1000;

const THRESHOLDS = Object.freeze([60, 30, 7, 0]);
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

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

function daysUntil(expiresAt, now = new Date()) {
  return Math.round((utcDay(new Date(expiresAt)) - utcDay(now)) / DAY_MS);
}

function expiryStatus(expiresAt, now = new Date()) {
  if (!expiresAt) return null;
  const days = daysUntil(expiresAt, now);
  if (days < 0) return 'expired';
  return days <= THRESHOLDS[0] ? 'soon' : 'ok';
}

function dueThreshold(days) {
  let due = null;
  for (const threshold of THRESHOLDS) if (days <= threshold) due = threshold;
  return due;
}

function thresholdsCovered(due) {
  return due === null ? [] : THRESHOLDS.filter((threshold) => threshold >= due);
}

module.exports = { THRESHOLDS, DAY_MS, parseExpiryInput, daysUntil, expiryStatus, dueThreshold, thresholdsCovered, utcDay };
