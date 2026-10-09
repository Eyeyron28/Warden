/**
 * The signed-in session's bearer token (`sessionId.sessionKey`).
 *
 * It lives in this tab's memory AND in sessionStorage, so a reload keeps you signed in. It is NEVER written
 * anywhere that outlives the tab: not localStorage, not a cookie, not IndexedDB. Closing the tab (or the
 * browser) ends it, exactly as before. What is NOT stored anywhere, on either side of the wire: the master
 * password and the unwrapped vault key. The server keeps the vault key wrapped under the second half of this
 * token, so the token is the only thing in this tab that can open the vault, and it expires after 30 idle
 * minutes server-side.
 *
 * THE TRADE-OFF, stated plainly: any script that runs inside this page can read sessionStorage (and, before
 * this change, the in-memory variable too, by other means). It is not readable by other sites, other tabs of
 * other origins, or by a copy of the browser profile once the tab is closed. The protection against injected
 * script is therefore the page's Content-Security-Policy (vercel.json: scripts only from this site, no inline
 * script except one hashed theme snippet, no eval, no plugins, no framing) and the fact that the app loads no
 * third-party script at all.
 *
 * A second tab: sessionStorage is per tab, so a newly opened tab asks the tabs that are already open (same
 * origin only, over a BroadcastChannel) for the token instead of making the person sign in again. The token
 * crosses only that in-browser channel and is stored in the new tab's sessionStorage like any other.
 *
 * axios interceptors run outside React's render cycle, so they read the token from here.
 */

const STORAGE_KEY = 'warden.session';
const CHANNEL_NAME = 'warden-session';
const TOKEN_SHAPE = /^[0-9a-f]{64}\.[0-9a-f]{64}$/i;
export const EXPIRED_MESSAGE = 'Your session expired. Sign in again.';

const listeners = new Set();
let notice = null;
let channel = null;

/** sessionStorage can throw (blocked, private mode): then the session simply lasts as long as the tab's memory. */
function readStored() {
  try {
    const value = window.sessionStorage.getItem(STORAGE_KEY);
    return typeof value === 'string' && TOKEN_SHAPE.test(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStored(value) {
  try {
    if (value) window.sessionStorage.setItem(STORAGE_KEY, value);
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing more to do
  }
}

let token = typeof window === 'undefined' ? null : readStored();

function openChannel() {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  channel = new BroadcastChannel(CHANNEL_NAME);
  // (Node, for the tests, would otherwise stay alive for an open channel; browsers have no unref.)
  channel.unref?.();
  channel.onmessage = (event) => {
    const message = event.data;
    if (message?.type === 'request' && token) channel.postMessage({ type: 'token', token });
    // Another tab signed out (or its session ended): this one's token is dead as well.
    if (message?.type === 'logout' && token && message.token === token) apply(null);
  };
  return channel;
}

function apply(next) {
  token = next;
  writeStored(next);
  listeners.forEach((listener) => listener(token));
}

export function getToken() {
  return token;
}

export function setToken(nextToken) {
  notice = null;
  apply(nextToken);
  if (typeof window !== 'undefined') openChannel();
}

/** Signing out on purpose (or after deleting the account): the token goes, with no message, and so do the other tabs'. */
export function clearToken() {
  const previous = token;
  apply(null);
  if (previous && channel) channel.postMessage({ type: 'logout', token: previous });
}

/** The server said the session is over (expired, signed out from another device): clear it and say so on the login page. */
export function expireSession(message = EXPIRED_MESSAGE) {
  const previous = token;
  apply(null);
  if (previous) notice = message;
  if (previous && channel) channel.postMessage({ type: 'logout', token: previous });
}

/** The message for the login page ("Your session expired. Sign in again."), shown once. */
export function takeSessionNotice() {
  const current = notice;
  notice = null;
  return current;
}

export function peekSessionNotice() {
  return notice;
}

/**
 * A tab with no token asks the other open tabs for theirs. Resolves with the token it adopted (already stored
 * in this tab's sessionStorage) or null after a short wait.
 */
export function adoptTokenFromOtherTabs(timeoutMs = 250) {
  if (token) return Promise.resolve(token);
  const bus = openChannel();
  if (!bus) return Promise.resolve(null);
  return new Promise((resolve) => {
    const finish = (value) => {
      bus.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(value);
    };
    const onMessage = (event) => {
      if (event.data?.type === 'token' && TOKEN_SHAPE.test(String(event.data.token))) {
        apply(event.data.token);
        finish(event.data.token);
      }
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    bus.addEventListener('message', onMessage);
    bus.postMessage({ type: 'request' });
  });
}

/**
 * Subscribes to token changes. Returns an unsubscribe function.
 * @param {(token: string | null) => void} listener
 */
export function subscribeToken(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== 'undefined') openChannel();
