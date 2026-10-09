/**
 * "Expires on" dates (passport, licence, ...). The server stores a calendar day as 00:00 UTC and sends it as an
 * ISO string; the first 10 characters ARE the day, so nothing here goes through the viewer's time zone.
 */

export const EXPIRY_STORAGE_NOTE =
  'This date is stored readable by the server, so Warden can email you a reminder while you are signed out. The file’s contents and name stay encrypted.';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2027-03-05T00:00:00.000Z" -> "2027-03-05" (the value an <input type="date"> takes), or ''. */
export function expiryDayValue(iso) {
  return typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : '';
}

/** "2027-03-05..." -> "Mar 5, 2027" */
export function formatExpiryDay(iso) {
  const day = expiryDayValue(iso);
  if (!day) return '';
  const [year, month, date] = day.split('-').map(Number);
  return `${MONTHS[month - 1]} ${date}, ${year}`;
}

/** The badge words for a list row: "Expired", "Expires today", "Expires in 12 days" (null when none is due). */
export function expiryBadge(doc) {
  if (!doc || (doc.expiryStatus !== 'expired' && doc.expiryStatus !== 'expiring_soon')) return null;
  if (doc.expiryStatus === 'expired') return { label: 'Expired', tone: 'danger' };
  const days = doc.daysUntilExpiry;
  return { label: days === 0 ? 'Expires today' : `Expires in ${days} day${days === 1 ? '' : 's'}`, tone: 'warning' };
}

/** A sentence for the Overview / banner: "Expired 3 days ago", "Expires today", "Expires in 12 days (Mar 5, 2027)". */
export function expiryPhrase(doc) {
  const days = doc.daysUntilExpiry;
  if (typeof days !== 'number') return '';
  if (days < 0) return `Expired ${-days} day${days === -1 ? '' : 's'} ago`;
  if (days === 0) return 'Expires today';
  return `Expires in ${days} day${days === 1 ? '' : 's'} (${formatExpiryDay(doc.docExpiresAt || doc.expiryDate)})`;
}
