/**
 * Plain-language wording for the activity timeline, and the time in Manila. The server sends structured rows
 * (type, target, device, country); the words are made here.
 */

export const GROUP_OPTIONS = Object.freeze([
  { value: '', label: 'All activity' },
  { value: 'vault', label: 'Vault' },
  { value: 'sharing', label: 'Sharing' },
  { value: 'account', label: 'Account' },
  { value: 'emergency', label: 'Emergency access' },
]);

const quoted = (target, fallback) => {
  if (!target || target.kind === 'none') return fallback;
  if (target.kind === 'folder') return 'a folder';
  if (target.gone || !target.name) return target.kind === 'share' ? 'a link that no longer exists' : 'a deleted file';
  return `'${target.name}'`;
};

/** "Downloaded 'passport.pdf'" */
export function describeEvent(event) {
  const { type, target } = event;
  const file = quoted(target, 'a file');
  switch (type) {
    case 'login': return 'Signed in';
    case 'login_failed': return 'Failed sign-in attempt';
    case 'logout': return 'Signed out';
    case 'otp_sent': return 'Sign-in code emailed';
    case 'password_changed': return 'Password changed';
    case 'trusted_added': return 'Trusted this browser';
    case 'trusted_removed': return 'Removed a trusted browser';
    case 'device_signed_out': return 'Signed out a device';
    case 'upload': return `Uploaded ${file}`;
    case 'view': return `Viewed ${file}`;
    case 'download': return `Downloaded ${file}`;
    case 'rename': return target?.kind === 'folder' || !target?.kind || target.kind === 'none' ? 'Renamed a folder' : `Renamed ${file}`;
    case 'move': return `Moved ${file}`;
    case 'delete': return `Moved ${file} to Trash or deleted it`;
    case 'restore': return `Restored ${file}`;
    case 'expiry_set': return `Set an expiry date on ${file}`;
    case 'expiry_cleared': return `Cleared the expiry date on ${file}`;
    case 'emergency_configured': return 'Set up emergency access';
    case 'emergency_kit_regenerated': return 'Replaced the emergency access kit';
    case 'emergency_revoked': return 'Turned off emergency access';
    case 'emergency_requested': return 'Your emergency contact requested access';
    case 'emergency_denied': return 'Denied an emergency access request';
    case 'emergency_approved_early': return 'Approved emergency access early';
    case 'emergency_released': return 'The waiting period ended: emergency access is available';
    case 'emergency_session_started': return 'Your emergency contact started a session';
    case 'emergency_file_viewed': return `Emergency contact viewed ${file}`;
    case 'emergency_file_downloaded': return `Emergency contact downloaded ${file}`;
    case 'trash_emptied': return 'Emptied Trash';
    case 'export':
    case 'account_export': return 'Exported all files as a zip';
    case 'import': return 'Imported files from a zip';
    case 'share_created': return `Created a share link for ${quoted(target, 'a file')}`;
    case 'share_revoked': return 'Stopped a share link';
    case 'share_opened': return 'Someone opened a share link';
    case 'share_downloaded': return 'Someone downloaded from a share link';
    case 'shares_stopped_all': return 'Stopped all share links';
    default: return 'Did something';
  }
}

/** Which icon name (utils in ActivityIcon) goes with an event. */
export function iconKind(type) {
  if (['login', 'logout', 'login_failed', 'otp_sent', 'password_changed', 'trusted_added', 'trusted_removed', 'device_signed_out'].includes(type)) return 'account';
  if (type.startsWith('emergency')) return 'emergency';
  if (type.startsWith('share')) return 'sharing';
  if (type === 'download' || type === 'export' || type === 'account_export') return 'download';
  if (type === 'upload' || type === 'import') return 'upload';
  if (type === 'delete' || type === 'trash_emptied') return 'trash';
  return 'vault';
}

/** "Oct 9, 2026, 5:14 PM" in Asia/Manila, with the zone named once ("PHT"). */
export function formatManila(value) {
  if (!value) return '';
  const text = new Date(value).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${text} PHT`;
}

/** A date input value (YYYY-MM-DD) as the start or end of that day in Manila (UTC+8), as an ISO string. */
export function manilaDayBoundary(dateText, end = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText || '')) return '';
  return new Date(`${dateText}T${end ? '23:59:59.999' : '00:00:00.000'}+08:00`).toISOString();
}

/** "Manila, Philippines" or just the country; "Unknown place" when there is neither. */
export function placeText({ city, countryName, country }) {
  const parts = [city, countryName || country].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Unknown place';
}
