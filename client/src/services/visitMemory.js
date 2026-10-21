import { isSafeRedirectPath } from '../utils/safeRedirect.js';

export const RETURN_ALLOWLIST = Object.freeze(['/files', '/starred', '/recent', '/photos', '/shared', '/trash', '/overview']);
export const RETURN_MAX_AGE_MS = 30 * 60 * 1000;
export const HOME_PATH = '/files';

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
  let visit = null;
  let account = null;
  let pending = null;

  const norm = (email) => String(email || '').trim().toLowerCase();

  return {
    trackVisit(path) {
      visit = typeof path === 'string' ? path : null;
    },
    rememberAccount(email) {
      account = norm(email) || null;
    },
    noteExpired() {
      const path = allowedReturnPath(visit);
      pending = path && account ? { path, account, at: now() } : null;
    },
    landingAfterLogin(email) {
      const kept = pending;
      pending = null;
      visit = null;
      if (!kept || kept.account !== norm(email) || now() - kept.at > RETURN_MAX_AGE_MS) return HOME_PATH;
      return allowedReturnPath(kept.path) || HOME_PATH;
    },
    clear({ keepReturn = false } = {}) {
      visit = null;
      account = null;
      if (!keepReturn) pending = null;
    },
    snapshot: () => ({ visit, account, pending }),
  };
}

export const visitMemory = createVisitMemory();
