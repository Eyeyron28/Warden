export const EXPIRY_PRESET_DAYS = [1, 3, 7, 14, 30];
export const DEFAULT_EXPIRY_DAYS = 7;
export const MAX_EXPIRY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const dayLabel = (days) => `${days} day${days === 1 ? '' : 's'}`;

export const daysToHours = (days) => days * 24;

export function customDaysProblem(text, max = MAX_EXPIRY_DAYS) {
  const value = String(text ?? '').trim();
  if (value === '') return 'Enter a number of days.';
  if (!/^\d+$/.test(value)) return `Enter a whole number of days, from 1 to ${max}.`;
  const days = Number(value);
  if (days < 1 || days > max) return `Choose from 1 to ${max} days.`;
  return '';
}

export function maxDaysUntil(maxEndMs, nowMs = Date.now()) {
  return Math.max(0, Math.min(MAX_EXPIRY_DAYS, Math.floor((maxEndMs - nowMs) / DAY_MS)));
}
