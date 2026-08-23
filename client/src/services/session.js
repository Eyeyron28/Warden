/**
 * In-memory session token holder.
 *
 * Deliberately NOT localStorage/sessionStorage: a stolen or left-open
 * browser session shouldn't survive a reload on a device that isn't
 * actually the vault owner's. This module state (and the React state
 * mirroring it via `subscribe`) lives only for the lifetime of the tab.
 *
 * axios interceptors run outside React's render cycle, so they read the
 * token from here rather than from component state (which would go
 * stale inside a closure captured at interceptor-registration time).
 */

let token = null;
const listeners = new Set();

export function getToken() {
  return token;
}

export function setToken(nextToken) {
  token = nextToken;
  listeners.forEach((listener) => listener(token));
}

export function clearToken() {
  setToken(null);
}

/**
 * Subscribes to token changes. Returns an unsubscribe function.
 * @param {(token: string | null) => void} listener
 */
export function subscribeToken(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
