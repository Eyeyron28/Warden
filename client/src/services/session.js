const STORAGE_KEY = 'warden.session';
const CHANNEL_NAME = 'warden-session';
const TOKEN_SHAPE = /^[0-9a-f]{64}\.[0-9a-f]{64}$/i;
export const EXPIRED_MESSAGE = 'Your session expired. Sign in again.';

const listeners = new Set();
let notice = null;
let channel = null;

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
  }
}

let token = typeof window === 'undefined' ? null : readStored();

function openChannel() {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.unref?.();
  channel.onmessage = (event) => {
    const message = event.data;
    if (message?.type === 'request' && token) channel.postMessage({ type: 'token', token });
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

export function clearToken() {
  const previous = token;
  apply(null);
  if (previous && channel) channel.postMessage({ type: 'logout', token: previous });
}

export function expireSession(message = EXPIRED_MESSAGE) {
  const previous = token;
  apply(null);
  if (previous) notice = message;
  if (previous && channel) channel.postMessage({ type: 'logout', token: previous });
}

export function takeSessionNotice() {
  const current = notice;
  notice = null;
  return current;
}

export function peekSessionNotice() {
  return notice;
}

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

export function subscribeToken(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== 'undefined') openChannel();
