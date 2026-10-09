import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { checkStoredSession } from './sessionCheck.js';

const TOKEN = `${'a1'.repeat(32)}.${'b2'.repeat(32)}`;
const OTHER = `${'c3'.repeat(32)}.${'d4'.repeat(32)}`;

/** A browser tab: its own sessionStorage, a localStorage and cookie jar that must never be touched. */
function makeTab() {
  const session = new Map();
  const touched = { local: 0, cookie: 0 };
  return {
    window: {
      sessionStorage: {
        getItem: (key) => (session.has(key) ? session.get(key) : null),
        setItem: (key, value) => void session.set(key, String(value)),
        removeItem: (key) => void session.delete(key),
      },
      get localStorage() {
        touched.local += 1;
        throw new Error('localStorage must never be used for the session');
      },
    },
    session,
    touched,
  };
}

let loads = 0;
const loaded = [];
/** Earlier tests' pages are still 'open' in this process; close their sessions so only this test's tabs answer. */
async function closeEarlierTabs() {
  for (const mod of loaded) mod.clearToken();
  await new Promise((resolve) => setTimeout(resolve, 60));
}
/** Loads a fresh copy of session.js, as if a page had just loaded in `tab`. */
async function pageLoad(tab) {
  globalThis.window = tab.window;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      get cookie() {
        tab.touched.cookie += 1;
        return '';
      },
      set cookie(value) {
        tab.touched.cookie += 1;
      },
    },
  });
  loads += 1;
  const mod = await import(`./session.js?load=${loads}`);
  loaded.push(mod);
  return mod;
}

test('a reload keeps the session: the token is read back from sessionStorage', async () => {
  const tab = makeTab();
  const first = await pageLoad(tab);
  assert.equal(first.getToken(), null);
  first.setToken(TOKEN);
  assert.equal(tab.session.get('warden.session'), TOKEN, 'kept in sessionStorage');

  const afterReload = await pageLoad(tab); // same tab, same sessionStorage, fresh page
  assert.equal(afterReload.getToken(), TOKEN);
  assert.deepEqual(tab.touched, { local: 0, cookie: 0 }, 'never localStorage, never a cookie');
});

test('closing the tab does not: a new tab has an empty sessionStorage and starts signed out', async () => {
  const tab = makeTab();
  (await pageLoad(tab)).setToken(TOKEN);
  const newTab = makeTab();
  const fresh = await pageLoad(newTab);
  assert.equal(fresh.getToken(), null);
  assert.equal(newTab.session.size, 0);
});

test('a stored value that is not shaped like a token is ignored, not trusted', async () => {
  for (const junk of ['', 'abc', 'a.b', `${'zz'.repeat(32)}.${'b2'.repeat(32)}`, `${TOKEN}extra`, '<script>']) {
    const tab = makeTab();
    tab.session.set('warden.session', junk);
    assert.equal((await pageLoad(tab)).getToken(), null, JSON.stringify(junk));
  }
});

test('logout clears it (and says nothing); an ended session clears it and leaves the message for the login page, once', async () => {
  const tab = makeTab();
  const session = await pageLoad(tab);
  session.setToken(TOKEN);
  session.clearToken();
  assert.equal(session.getToken(), null);
  assert.equal(tab.session.has('warden.session'), false, 'removed from sessionStorage');
  assert.equal(session.takeSessionNotice(), null, 'signing out on purpose is not an "expired" message');

  session.setToken(TOKEN);
  session.expireSession();
  assert.equal(tab.session.has('warden.session'), false);
  assert.equal(session.takeSessionNotice(), 'Your session expired. Sign in again.');
  assert.equal(session.takeSessionNotice(), null, 'shown once');
  session.expireSession();
  assert.equal(session.takeSessionNotice(), null, 'no token, nothing to announce');
  assert.equal(session.EXPIRED_MESSAGE, 'Your session expired. Sign in again.');

  // signing in again drops any old message
  session.setToken(TOKEN);
  session.expireSession();
  session.setToken(OTHER);
  assert.equal(session.takeSessionNotice(), null);
});

test('subscribers hear every change (the guard and the axios interceptor depend on it)', async () => {
  const session = await pageLoad(makeTab());
  const seen = [];
  const stop = session.subscribeToken((value) => seen.push(value));
  session.setToken(TOKEN);
  session.expireSession();
  stop();
  session.setToken(OTHER);
  assert.deepEqual(seen, [TOKEN, null]);
});

test('a second tab takes the session from the first over the same-origin channel; a logout reaches it; nothing persistent is written', async () => {
  await closeEarlierTabs();
  const tabA = makeTab();
  const tabB = makeTab();
  const a = await pageLoad(tabA);
  a.setToken(TOKEN);
  const b = await pageLoad(tabB);
  assert.equal(b.getToken(), null, 'a new tab starts without it');

  const adopted = await b.adoptTokenFromOtherTabs(500);
  assert.equal(adopted, TOKEN);
  assert.equal(b.getToken(), TOKEN);
  assert.equal(tabB.session.get('warden.session'), TOKEN, 'stored for THIS tab only, in sessionStorage');
  assert.deepEqual(tabB.touched, { local: 0, cookie: 0 });

  // signing out in one tab ends it in the other
  a.clearToken();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(b.getToken(), null);
  assert.equal(tabB.session.has('warden.session'), false);

  // nobody to ask: it gives up quickly and the visitor signs in normally
  const lonely = await pageLoad(makeTab());
  const started = Date.now();
  assert.equal(await lonely.adoptTokenFromOtherTabs(150), null);
  assert.ok(Date.now() - started < 600);
});

test('a token that another tab sends but is not shaped like one is refused', async () => {
  await closeEarlierTabs();
  const tab = makeTab();
  const session = await pageLoad(tab);
  const rogue = new BroadcastChannel('warden-session');
  const waiting = session.adoptTokenFromOtherTabs(300);
  rogue.postMessage({ type: 'token', token: 'not-a-token' });
  assert.equal(await waiting, null);
  assert.equal(tab.session.size, 0);
  rogue.close();
});

test('the session module stores the token nowhere but sessionStorage', () => {
  const text = readFileSync(fileURLToPath(new URL('./session.js', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(text, /localStorage|document\.cookie|indexedDB|caches\./);
  assert.match(text, /sessionStorage/);
  // and the rest of the client never reads or writes it by another route
  const app = readFileSync(fileURLToPath(new URL('../App.jsx', import.meta.url)), 'utf8');
  assert.doesNotMatch(app, /sessionStorage|localStorage/);
});

// ---------- what the page does with a stored token when it starts ----------

const unauthorized = () => Object.assign(new Error('401'), { response: { status: 401, data: { error: { code: 'SESSION_INVALID' } } } });
const offline = () => Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });
const deps = (overrides = {}) => {
  const calls = { verify: 0, expire: 0, adopt: 0 };
  return {
    calls,
    getToken: () => TOKEN,
    adoptFromOtherTabs: async () => { calls.adopt += 1; return null; },
    verify: async () => { calls.verify += 1; },
    expire: () => { calls.expire += 1; },
    ...overrides,
  };
};

test('start-up: a good token stays; a refused one is cleared with the message; a dead connection keeps it', async () => {
  const good = deps();
  assert.equal(await checkStoredSession(good), 'valid');
  assert.deepEqual(good.calls, { verify: 1, expire: 0, adopt: 0 });

  const refused = deps({ verify: async () => { throw unauthorized(); } });
  assert.equal(await checkStoredSession(refused), 'expired');
  assert.equal(refused.calls.expire, 1, 'expired or revoked: storage cleared and the message queued');

  const down = deps({ verify: async () => { throw offline(); } });
  assert.equal(await checkStoredSession(down), 'unverified');
  assert.equal(down.calls.expire, 0, 'no connection is not a dead session');

  const server500 = deps({ verify: async () => { throw Object.assign(new Error('x'), { response: { status: 503 } }); } });
  assert.equal(await checkStoredSession(server500), 'unverified');
  assert.equal(server500.calls.expire, 0);
});

test('start-up: with no token it asks the other tabs once, and does nothing if none answers', async () => {
  const none = deps({ getToken: () => null });
  assert.equal(await checkStoredSession(none), 'none');
  assert.deepEqual(none.calls, { verify: 0, expire: 0, adopt: 1 });

  const handedOver = deps({ getToken: () => null, adoptFromOtherTabs: async () => TOKEN });
  assert.equal(await checkStoredSession(handedOver), 'valid');
  assert.equal(handedOver.calls.verify, 1, 'a token from another tab is proved too');
});

test('the axios interceptor ends a session the server no longer accepts, and the guard waits for the start-up check', () => {
  const api = readFileSync(fileURLToPath(new URL('./api.js', import.meta.url)), 'utf8');
  assert.match(api, /if \(getToken\(\)\) expireSession\(\);\s*else clearToken\(\);/);
  const app = readFileSync(fileURLToPath(new URL('../App.jsx', import.meta.url)), 'utf8');
  assert.match(app, /if \(!ready\) return null;/);
  assert.match(app, /checkStoredSession\(\{ getToken, adoptFromOtherTabs: adoptTokenFromOtherTabs, verify: getMe, expire: expireSession \}\)/);
  const login = readFileSync(fileURLToPath(new URL('../pages/auth/LoginPage.jsx', import.meta.url)), 'utf8');
  assert.match(login, /takeSessionNotice\(\)/);
  assert.match(login, /\{sessionNotice &&/);
});
