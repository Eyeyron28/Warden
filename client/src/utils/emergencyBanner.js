/**
 * The owner's app-wide banner while a request is open, and the live countdown on the Emergency Access page.
 * Both read the server's status, so they come back after a reload; the only thing remembered in the browser is
 * "this tab's session dismissed that request's banner" (a request id, nothing secret).
 */

export const DISMISS_KEY_PREFIX = 'warden.emergencyBanner.';

/** An open request: waiting (pending) or released (the wait ended, the contact can come in). */
export function openRequestOf(status) {
  const request = status?.request;
  return request && (request.status === 'pending' || request.status === 'released') ? request : null;
}

/**
 * Whether to show the banner, and what to say. `formatWhen(releaseAt)` renders the time in Asia/Manila.
 * @returns {{ show: boolean, text: string, requestId: string | null, released: boolean }}
 */
export function bannerFor(status, { dismissedId = null, formatWhen, now = Date.now() } = {}) {
  const request = openRequestOf(status);
  if (!request || dismissedId === request.id) return { show: false, text: '', requestId: request?.id ?? null, released: false };
  const released = request.status === 'released' || new Date(request.releaseAt).getTime() <= now;
  const text = released
    ? 'Your emergency contact can now open your vault (read-only). You can still deny the request or turn access off.'
    : `Someone requested emergency access. It will be granted on ${formatWhen(request.releaseAt)} unless you deny it.`;
  return { show: true, text, requestId: request.id, released };
}

/** "2 days 4 hours", "3 hours 12 minutes", "5 minutes 8 seconds", "42 seconds", "now". */
export function formatCountdown(ms) {
  if (!(ms > 0)) return 'now';
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const unit = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (days > 0) return hours ? `${unit(days, 'day')} ${unit(hours, 'hour')}` : unit(days, 'day');
  if (hours > 0) return minutes ? `${unit(hours, 'hour')} ${unit(minutes, 'minute')}` : unit(hours, 'hour');
  if (minutes > 0) return `${unit(minutes, 'minute')} ${unit(seconds, 'second')}`;
  return unit(seconds, 'second');
}

export const dismissKey = (requestId) => `${DISMISS_KEY_PREFIX}${requestId}`;
