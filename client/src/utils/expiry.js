export const EXPIRY_STORAGE_NOTE =
  'This date is stored readable by the server, so Warden can email you a reminder while you are signed out. The file’s contents and name stay encrypted.';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function expiryDayValue(iso) {
  return typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : '';
}

export function formatExpiryDay(iso) {
  const day = expiryDayValue(iso);
  if (!day) return '';
  const [year, month, date] = day.split('-').map(Number);
  return `${MONTHS[month - 1]} ${date}, ${year}`;
}

export function expiryBadge(doc) {
  if (!doc || (doc.expiryStatus !== 'expired' && doc.expiryStatus !== 'expiring_soon')) return null;
  if (doc.expiryStatus === 'expired') return { label: 'Expired', tone: 'danger' };
  const days = doc.daysUntilExpiry;
  return { label: days === 0 ? 'Expires today' : `Expires in ${days} day${days === 1 ? '' : 's'}`, tone: 'warning' };
}

export function expiryPhrase(doc) {
  const days = doc.daysUntilExpiry;
  if (typeof days !== 'number') return '';
  if (days < 0) return `Expired ${-days} day${days === -1 ? '' : 's'} ago`;
  if (days === 0) return 'Expires today';
  return `Expires in ${days} day${days === 1 ? '' : 's'} (${formatExpiryDay(doc.docExpiresAt || doc.expiryDate)})`;
}
