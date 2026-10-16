import { invalidateAll } from './dataCache.js';
import { clearEmergencyFlag, leaveEmergencyMode } from './emergencyMode.js';
import { importJob } from './importJob.js';
import { transfers } from './transfers.js';
import { getToken, peekSessionNotice, subscribeToken } from './session.js';
import { visitMemory } from './visitMemory.js';

/**
 * ONE place that forgets the previous visit. Every way a session ends - signing out, Lock vault, an expiry, a 401, another account
 * signing in - goes through forgetPreviousVisit(): the stored return page, the emergency session's state and flag, the page cache,
 * the import job (and its report), and every `warden.*` item kept in this tab's sessionStorage (banner dismissals, the sign-up
 * draft, ...). The session token itself is session.js's own business and is gone before this runs; the theme (a localStorage
 * preference, not part of a visit) is not touched.
 *
 * reason:
 *   'signout'  - the person signed out or locked the vault, or a different account took over: everything goes;
 *   'expired'  - the server ended the session: the same, except the one return page for a same-account sign-in, the "access ended"
 *                flag (the contact's page says so), and the import job (which reports that it stopped, services/importJob.js).
 */
export function createSessionReset(deps) {
  const { visitMemory: memory, invalidateCache, leaveEmergency, clearEmergency, clearImport, clearTransfers = () => {}, storage } = deps;
  return function forgetPreviousVisit({ reason = 'signout' } = {}) {
    const expired = reason === 'expired';
    memory.clear({ keepReturn: expired });
    invalidateCache();
    clearTransfers(); // every queued, running and finished transfer, names included
    leaveEmergency({ keepFlag: expired });
    if (!expired) {
      clearEmergency();
      clearImport();
    }
    try {
      if (storage) {
        const keys = [];
        for (let i = 0; i < storage.length; i += 1) keys.push(storage.key(i));
        for (const key of keys) {
          if (!key.startsWith('warden.') || key === 'warden.session') continue;
          if (expired && key === 'warden.emergencyMode') continue;
          storage.removeItem(key);
        }
      }
    } catch {
      // storage can be blocked; there is then nothing in it to forget
    }
  };
}

export const forgetPreviousVisit = createSessionReset({
  visitMemory,
  invalidateCache: invalidateAll,
  leaveEmergency: leaveEmergencyMode,
  clearEmergency: clearEmergencyFlag,
  clearImport: () => importJob.clear(),
  clearTransfers: () => transfers.clear(),
  storage: typeof window === 'undefined' ? null : window.sessionStorage,
});

/**
 * Wires it to the session, once (main.jsx): whenever the token goes, or becomes a different one, the previous visit is forgotten -
 * whichever code path caused it. A session the server ended is told apart by session.js's expiry notice (which is set just after
 * listeners run, hence the microtask).
 */
export function installSessionReset(handlers = {}) {
  const { forget = forgetPreviousVisit, token = getToken, subscribe = subscribeToken, notice = peekSessionNotice, win = typeof window === 'undefined' ? null : window } = handlers;
  let current = token();
  subscribe((next) => {
    const previous = current;
    current = next;
    if (next && previous && next !== previous) {
      // another account (or a new sign-in over an old one): nothing of the old visit may carry over
      forget({ reason: 'signout' });
      return;
    }
    if (next) return; // a first sign-in: nothing to forget
    Promise.resolve().then(() => {
      const expired = Boolean(notice());
      if (expired) visitMemory.noteExpired();
      forget({ reason: expired ? 'expired' : 'signout' });
    });
  });
  // The browser's back/forward cache can bring back a page's old picture after sign-out: with no session, go to the sign-in page.
  win?.addEventListener('pageshow', (event) => {
    if (event.persisted && !token()) {
      win.history.replaceState(null, '', '/login');
      win.dispatchEvent(new PopStateEvent('popstate'));
    }
  });
}
