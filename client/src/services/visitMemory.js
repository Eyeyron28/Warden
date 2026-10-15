import { isSafeRedirectPath } from '../utils/safeRedirect.js';

/**
 * What the app remembers about the CURRENT visit, in memory only (never storage, never router state, never the URL), so that
 * one helper (services/sessionReset.js) can forget all of it.
 *
 * It exists for exactly one thing: when the SERVER ends a session (expiry, a 401) the person may be sent back to the page they were
 * on after signing in again - but only as the same account, soon after, and only to a short list of ordinary pages. Every other
 * sign-in lands on My Files, whatever page the person left.
 */

// The only pages a session-expiry sign-in may return to. Settings, Devices, Import, Emergency Access and the emergency pages are
// never restored, and neither is anything that is not on this list.
export const RETURN_ALLOWLIST = Object.freeze(['/files', '/starred', '/recent', '/photos', '/shared', '/trash', '/overview']);
// The same 30 minutes as an idle session: a much older expiry is just a new visit.
export const RETURN_MAX_AGE_MS = 30 * 60 * 1000;
export const HOME_PATH = '/files';

/**
 * The page to return to for `path`, or null when it may not be restored. Never a full URL, protocol or host: it must be a safe
 * internal path whose pathname is on the list. Only /files keeps a query, and only its `path=` folder.
 */
export function allowedReturnPath(path) {
  if (!isSafeRedirectPath(path)) return null;
  const [pathname, query = ''] = String(path).split('#')[0].split('?');
  const clean = pathname.replace(/\/+$/, '') || '/';
  if (!RETURN_ALLOWLIST.includes(clean)) return null;
  if (clean === '/files' && query) {
    const folder = new URLSearchParams(query).get('path');
    if (folder) return `/files?path=${encodeURIComponent(folder)}`;
  }
  return clean;
}

export function createVisitMemory({ now = Date.now } = {}) {
  let visit = null; // the page being looked at, while signed in
  let account = null; // the signed-in account's address, lower case
  let pending = null; // { path, account, at }: set only when the server ended the session

  const norm = (email) => String(email || '').trim().toLowerCase();

  return {
    trackVisit(path) {
      visit = typeof path === 'string' ? path : null;
    },
    rememberAccount(email) {
      account = norm(email) || null;
    },
    /** The server ended the session: keep the page (and who it was) for one sign-in. */
    noteExpired() {
      const path = allowedReturnPath(visit);
      pending = path && account ? { path, account, at: now() } : null;
    },
    /**
     * Where a sign-in as `email` lands: My Files - unless this is the same account signing in again shortly after the server ended
     * its session on an allowed page. The memory of that page is spent either way.
     */
    landingAfterLogin(email) {
      const kept = pending;
      pending = null;
      visit = null;
      if (!kept || kept.account !== norm(email) || now() - kept.at > RETURN_MAX_AGE_MS) return HOME_PATH;
      return allowedReturnPath(kept.path) || HOME_PATH;
    },
    /** Forget the visit. `keepReturn` leaves the one expiry return in place (an expired session; every other end throws it away). */
    clear({ keepReturn = false } = {}) {
      visit = null;
      account = null;
      if (!keepReturn) pending = null;
    },
    snapshot: () => ({ visit, account, pending }),
  };
}

export const visitMemory = createVisitMemory();
