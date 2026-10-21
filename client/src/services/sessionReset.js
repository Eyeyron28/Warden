import { invalidateAll } from './dataCache.js';
import { clearEmergencyFlag, leaveEmergencyMode } from './emergencyMode.js';
import { importJob } from './importJob.js';
import { transfers } from './transfers.js';
import { getToken, peekSessionNotice, subscribeToken } from './session.js';
import { visitMemory } from './visitMemory.js';

export function createSessionReset(deps) {
  const { visitMemory: memory, invalidateCache, leaveEmergency, clearEmergency, clearImport, clearTransfers = () => {}, storage } = deps;
  return function forgetPreviousVisit({ reason = 'signout' } = {}) {
    const expired = reason === 'expired';
    memory.clear({ keepReturn: expired });
    invalidateCache();
    clearTransfers();
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

export function installSessionReset(handlers = {}) {
  const { forget = forgetPreviousVisit, token = getToken, subscribe = subscribeToken, notice = peekSessionNotice, win = typeof window === 'undefined' ? null : window } = handlers;
  let current = token();
  subscribe((next) => {
    const previous = current;
    current = next;
    if (next && previous && next !== previous) {
      forget({ reason: 'signout' });
      return;
    }
    if (next) return;
    Promise.resolve().then(() => {
      const expired = Boolean(notice());
      if (expired) visitMemory.noteExpired();
      forget({ reason: expired ? 'expired' : 'signout' });
    });
  });
  win?.addEventListener('pageshow', (event) => {
    if (event.persisted && !token()) {
      win.history.replaceState(null, '', '/login');
      win.dispatchEvent(new PopStateEvent('popstate'));
    }
  });
}
