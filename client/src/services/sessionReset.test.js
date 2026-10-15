import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOME_PATH, RETURN_ALLOWLIST, RETURN_MAX_AGE_MS, allowedReturnPath, createVisitMemory } from './visitMemory.js';
import { createSessionReset, installSessionReset } from './sessionReset.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const flush = () => new Promise((resolve) => setImmediate(resolve));

// ---------- where a sign-in lands ----------

test('a fresh sign-in lands on My Files, whatever page was left and whatever is left over in memory', () => {
  const memory = createVisitMemory();
  assert.equal(memory.landingAfterLogin('a@example.com'), HOME_PATH);
  // a visit and an account are known, but nothing says the server ended the session: still My Files
  memory.trackVisit('/devices');
  memory.rememberAccount('a@example.com');
  assert.equal(memory.landingAfterLogin('a@example.com'), '/files');
  memory.trackVisit('/trash');
  memory.rememberAccount('a@example.com');
  assert.equal(memory.landingAfterLogin('a@example.com'), '/files', 'a visit alone is not an expiry');
});

test('a session the SERVER ended returns the same account to an allowed page, once', () => {
  const memory = createVisitMemory();
  memory.trackVisit('/overview');
  memory.rememberAccount('Ana@Example.com');
  memory.noteExpired();
  memory.clear({ keepReturn: true }); // what the reset does for an expiry
  assert.equal(memory.landingAfterLogin(' ana@example.com '), '/overview');
  assert.equal(memory.landingAfterLogin('ana@example.com'), '/files', 'spent: the next sign-in is a fresh one');
});

test('a different account, a stale expiry, or a page that is not on the list lands on My Files', () => {
  let clock = 1_000_000;
  const memory = createVisitMemory({ now: () => clock });
  const expireOn = (page, who = 'ana@example.com') => {
    memory.trackVisit(page);
    memory.rememberAccount(who);
    memory.noteExpired();
    memory.clear({ keepReturn: true });
  };
  expireOn('/shared');
  assert.equal(memory.landingAfterLogin('bob@example.com'), '/files', 'another account');
  expireOn('/shared');
  clock += RETURN_MAX_AGE_MS + 1;
  assert.equal(memory.landingAfterLogin('ana@example.com'), '/files', 'too old to be the same visit');
  for (const page of ['/devices', '/account', '/export', '/emergency-access', '/emergency', '/login', '/']) {
    expireOn(page);
    assert.equal(memory.landingAfterLogin('ana@example.com'), '/files', `${page} is never restored`);
  }
  // no account known (never asked the server who it was): nothing to compare, so nothing is restored
  memory.clear();
  memory.trackVisit('/trash');
  memory.noteExpired();
  assert.equal(memory.landingAfterLogin('ana@example.com'), '/files');
});

test('the allowlist is short and holds only ordinary file pages; a full URL, a protocol, a host or a trick falls back to Files', () => {
  assert.deepEqual([...RETURN_ALLOWLIST], ['/files', '/starred', '/recent', '/photos', '/shared', '/trash', '/overview']);
  for (const ok of ['/files', '/trash/', '/overview?x=1']) assert.ok(allowedReturnPath(ok), ok);
  assert.equal(allowedReturnPath('/overview?x=1'), '/overview', 'a query is dropped');
  assert.equal(allowedReturnPath('/files?path=Taxes%2F2024'), '/files?path=Taxes%2F2024', 'only a folder path is kept for Files');
  assert.equal(allowedReturnPath('/files?path=Taxes&evil=1'), '/files?path=Taxes');
  for (const bad of ['https://evil.example/files', '//evil.example/files', '/\\evil.example', 'javascript:alert(1)', 'files', '', null, undefined, 42, '/files/../devices', '/devices', '/account', '/emergency-access', '/export', '/%2e%2e/devices', '/files\t', `/${'a'.repeat(3000)}`]) {
    assert.equal(allowedReturnPath(bad), null, String(bad));
  }
  const memory = createVisitMemory();
  memory.rememberAccount('a@example.com');
  memory.trackVisit('https://evil.example/files');
  memory.noteExpired();
  assert.equal(memory.landingAfterLogin('a@example.com'), '/files');
});

// ---------- the one helper that forgets ----------

function fakeStorage(entries) {
  const map = new Map(Object.entries(entries));
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (key) => map.delete(key),
    keys: () => [...map.keys()],
  };
}

function rig() {
  const memory = createVisitMemory();
  const calls = [];
  const storage = fakeStorage({
    'warden.session': 'token',
    'warden.emergencyMode': '1',
    'warden.signup.email': 'someone@example.com',
    'warden.expiryBannerDismissed': '1',
    'warden.emergencyBannerDismissed.123': '1',
    'warden-theme': 'dark', // a preference (and not a `warden.` key): never part of a visit
  });
  const forget = createSessionReset({
    visitMemory: memory,
    invalidateCache: () => calls.push('cache'),
    leaveEmergency: (options) => calls.push(`leave-emergency${options?.keepFlag ? '-keep-flag' : ''}`),
    clearEmergency: () => calls.push('clear-flag'),
    clearImport: () => calls.push('clear-import'),
    storage,
  });
  return { memory, forget, calls, storage };
}

test('signing out forgets everything: the return page, the account, the cache, the emergency state and flag, the import job and every warden.* item', () => {
  const r = rig();
  r.memory.trackVisit('/devices');
  r.memory.rememberAccount('a@example.com');
  r.memory.noteExpired();
  r.forget({ reason: 'signout' });
  assert.deepEqual(r.memory.snapshot(), { visit: null, account: null, pending: null });
  assert.deepEqual(r.calls, ['cache', 'leave-emergency', 'clear-flag', 'clear-import']);
  assert.deepEqual(r.storage.keys(), ['warden.session', 'warden-theme'], 'only the token (session.js clears that) and the theme are left');
});

test('an expiry keeps ONLY the one return page, the "access ended" flag and the import job (which reports that it stopped)', () => {
  const r = rig();
  r.memory.trackVisit('/trash');
  r.memory.rememberAccount('a@example.com');
  r.memory.noteExpired();
  r.forget({ reason: 'expired' });
  assert.equal(r.memory.snapshot().pending.path, '/trash');
  assert.equal(r.memory.snapshot().visit, null);
  assert.equal(r.memory.snapshot().account, null);
  assert.deepEqual(r.calls, ['cache', 'leave-emergency-keep-flag']);
  assert.ok(r.storage.keys().includes('warden.emergencyMode'));
  assert.ok(!r.storage.keys().includes('warden.signup.email'));
  assert.ok(!r.storage.keys().includes('warden.expiryBannerDismissed'));
  // and a sign-out afterwards (or any other end) takes even that
  r.forget({ reason: 'signout' });
  assert.equal(r.memory.snapshot().pending, null);
});

test('it works when storage is blocked', () => {
  const memory = createVisitMemory();
  const forget = createSessionReset({
    visitMemory: memory, invalidateCache() {}, leaveEmergency() {}, clearEmergency() {}, clearImport() {},
    storage: { get length() { throw new Error('blocked'); } },
  });
  assert.doesNotThrow(() => forget({ reason: 'signout' }));
});

// ---------- wired to the session: every way a session ends ----------

function sessionRig() {
  const listeners = new Set();
  const state = { token: 'token-A', notice: null, forgets: [], memory: createVisitMemory() };
  const win = { listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
  installSessionReset({
    forget: (options) => state.forgets.push(options.reason),
    token: () => state.token,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    notice: () => state.notice,
    win,
  });
  state.set = (next, notice = null) => { state.token = next; state.notice = notice; listeners.forEach((listener) => listener(next)); };
  state.win = win;
  return state;
}

test('logout, Lock vault and a 401-less sign-out (the token just goes) forget everything', async () => {
  const s = sessionRig();
  s.set(null);
  await flush();
  assert.deepEqual(s.forgets, ['signout']);
});

test('a session the server ended (the expiry notice is set) forgets as an expiry', async () => {
  const s = sessionRig();
  s.set(null, 'Your session expired. Sign in again.');
  await flush();
  assert.deepEqual(s.forgets, ['expired']);
});

test('a different account taking over (a new token over an old one) forgets everything at once; a first sign-in forgets nothing', async () => {
  const s = sessionRig();
  s.set('token-B');
  assert.deepEqual(s.forgets, ['signout'], 'synchronously');
  const t = sessionRig();
  t.set(null);
  await flush();
  t.forgets.length = 0;
  t.set('token-C');
  await flush();
  assert.deepEqual(t.forgets, [], 'null to a token is just signing in');
});

test('after logout the browser Back/forward cache cannot bring the old page back: a restored page with no session goes to sign-in', () => {
  const calls = [];
  const win = {
    history: { replaceState: (...args) => calls.push(args) },
    dispatchEvent: (event) => calls.push(event.type),
    addEventListener(type, fn) { this.handler = fn; },
  };
  globalThis.PopStateEvent ||= class { constructor(type) { this.type = type; } };
  installSessionReset({ forget() {}, token: () => null, subscribe: () => () => {}, notice: () => null, win });
  win.handler({ persisted: false });
  assert.equal(calls.length, 0);
  win.handler({ persisted: true });
  assert.deepEqual(calls[0], [null, '', '/login']);
  assert.equal(calls[1], 'popstate');
});

// ---------- the code: nothing carries a page across a sign-out ----------

test('no router state, query parameter or storage carries the previous page: the guard sends a plain /login, the login page reads nothing from the URL', () => {
  const app = strip(read('App.jsx'));
  assert.match(app, /<Navigate to="\/login" replace \/>/);
  assert.doesNotMatch(app, /state=\{\{ from/);
  const login = strip(read('pages/auth/LoginPage.jsx'));
  assert.doesNotMatch(login, /location\.state\?\.from|returnPathFrom|from\.pathname/);
  assert.doesNotMatch(strip(read('services/visitMemory.js')), /sessionStorage|localStorage|indexedDB|history\.state/);
  // every sign-in route that is not a code-checked expiry goes to /files, with replace
  assert.match(login, /navigate\(landing, \{ replace: true \}\)/);
  assert.match(login, /<Navigate to="\/files" replace \/>/);
  const signup = strip(read('pages/auth/SignupPage.jsx'));
  assert.match(signup, /navigate\('\/files', \{ replace: true \}\)/);
  assert.match(strip(read('pages/EmergencyContactPage.jsx')), /navigate\('\/files', \{ replace: true \}\)/);
});

test('every way of signing out calls the one helper, and the session wiring is installed once at start-up', () => {
  for (const file of ['App.jsx', 'pages/DevicesPage.jsx', 'pages/AccountPage.jsx', 'components/emergency/EmergencyShell.jsx']) {
    assert.match(strip(read(file)), /forgetPreviousVisit\(\{ reason: 'signout' \}\)/, file);
  }
  assert.match(strip(read('main.jsx')), /installSessionReset\(\);/);
  const reset = strip(read('services/sessionReset.js'));
  for (const part of ['memory.clear(', 'invalidateCache()', 'leaveEmergency(', 'clearEmergency()', 'clearImport()', "storage.removeItem(key)"]) assert.ok(reset.includes(part), part);
});

test('an emergency session and an owner session are never active together: signing in ends the emergency state, and an emergency sign-out goes to sign-in', () => {
  const login = strip(read('pages/auth/LoginPage.jsx'));
  assert.match(login, /leaveEmergencyMode\(\);[\s\S]*setToken\(sessionToken\)/, 'the owner sign-in ends the emergency state first');
  assert.match(login, /token && !emergency\.emergency/, 'an emergency token does not count as being signed in here');
  const shell = strip(read('components/emergency/EmergencyShell.jsx'));
  assert.match(shell, /forgetPreviousVisit\(\{ reason: 'signout' \}\);\s*clearToken\(\);/);
  assert.match(shell, /expireSession\('Emergency access has ended\.'\)/, 'the 4 hours running out is an ended session, not a sign-out');
  const contact = strip(read('pages/EmergencyContactPage.jsx'));
  assert.match(contact, /clearToken\(\);\s*setToken\(result\.sessionToken\);\s*enterEmergencyMode/, 'starting an emergency session first ends any other');
});
