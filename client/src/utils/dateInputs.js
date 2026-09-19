// Local-time formatting for native <input type="date"> / "datetime-local">
// min attributes - deliberately NOT going through toISOString() (which
// converts to UTC first and can roll the date backward/forward a day
// depending on the browser's timezone offset). These read the same local
// year/month/day/hour/minute the browser itself would show as "now", so
// "today" here always matches whatever day it visually is for the person
// sitting at this device.

function pad(value) {
  return String(value).padStart(2, '0');
}

/**
 * "YYYY-MM-DD" for today, suitable for an <input type="date">'s min
 * attribute so past dates render disabled/unselectable.
 */
export function getTodayDateInputValue() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * "YYYY-MM-DDTHH:mm" for right now, suitable for an
 * <input type="datetime-local">'s min attribute.
 */
export function getNowDateTimeInputValue() {
  const now = new Date();
  return `${getTodayDateInputValue()}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}
