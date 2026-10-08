/**
 * Share-link lifetimes, in whole days. The interface never offers hours: the choices
 * are 1, 3, 7 (the default), 14 and 30 days, or a custom number of days from 1 to 30.
 * (The server still takes `durationHours`, within its 30-day cap, so shorter values
 * stay possible for tests and scripts; this module just turns days into that.)
 */

export const EXPIRY_PRESET_DAYS = [1, 3, 7, 14, 30];
export const DEFAULT_EXPIRY_DAYS = 7;
export const MAX_EXPIRY_DAYS = 30; // the server's cap too (utils/shareLimits.js MAX_DURATION_HOURS)
const DAY_MS = 24 * 60 * 60 * 1000;

export const dayLabel = (days) => `${days} day${days === 1 ? '' : 's'}`;

/** What the server takes: hours from now. */
export const daysToHours = (days) => days * 24;

/** '' when `text` is a whole number of days within 1..max; otherwise the message to show. */
export function customDaysProblem(text, max = MAX_EXPIRY_DAYS) {
  const value = String(text ?? '').trim();
  if (value === '') return 'Enter a number of days.';
  if (!/^\d+$/.test(value)) return `Enter a whole number of days, from 1 to ${max}.`;
  const days = Number(value);
  if (days < 1 || days > max) return `Choose from 1 to ${max} days.`;
  return '';
}

/** How many whole days a share that must end by `maxEndMs` can still be given from `nowMs` (0 when none). */
export function maxDaysUntil(maxEndMs, nowMs = Date.now()) {
  return Math.max(0, Math.min(MAX_EXPIRY_DAYS, Math.floor((maxEndMs - nowMs) / DAY_MS)));
}
