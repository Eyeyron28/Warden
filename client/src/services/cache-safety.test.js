import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import api from './api.js';
import { cacheSize, invalidateAll, peek } from './dataCache.js';
import { clearToken, expireSession, getToken, peekSessionNotice, setToken, takeSessionNotice } from './session.js';
import { listDocuments, listExpiringDocuments, peekDocuments } from './documentsService.js';
import { getFrequentFiles } from './insightsService.js';
import { getEmergencyStatus, peekEmergencyStatus } from './emergencyService.js';
import { logoutVault } from './authService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const A = `${'a1'.repeat(32)}.${'b2'.repeat(32)}`;
const B = `${'c3'.repeat(32)}.${'d4'.repeat(32)}`;

function server({ hold = false, status = 200, code } = {}) {
  const pending = [];
  api.defaults.adapter = (config) => {
    const who = String(config.headers?.Authorization || config.headers?.get?.('Authorization') || '').includes(A.slice(0, 8)) ? 'A' : 'B';
    return new Promise((resolve, reject) => {
      const answer = () => {
        if (status !== 200) return reject(Object.assign(new Error('refused'), { config, response: { status, data: { error: { code, message: 'no' } } } }));
        const data = config.url === '/documents' ? [{ id: `${who}-doc` }] : config.url === '/insights/frequent' ? { items: [{ id: `${who}-freq` }] } : config.url === '/emergency/status' ? { owner: who } : [];
        return resolve({ data, status: 200, statusText: 'OK', headers: {}, config });
      };
      if (hold) pending.push(answer);
      else answer();
    });
  };
  return { release: () => pending.splice(0).forEach((answer) => answer()) };
}

async function fill() {
  await Promise.all([listDocuments(), getFrequentFiles(), getEmergencyStatus(), listExpiringDocuments()]);
  assert.ok(cacheSize() >= 4, 'the cache holds this session’s lists');
}

test.beforeEach(() => {
  clearToken();
  invalidateAll();
  takeSessionNotice();
});

test('logout empties the cache at once (before, and whether or not, the logout request succeeds)', async () => {
  server();
  setToken(A);
  await fill();
  clearToken();
  assert.equal(cacheSize(), 0);
  assert.equal(peekDocuments(), undefined);

  setToken(A);
  await fill();
  server({ status: 500 });
  await logoutVault().catch(() => {});
  clearToken();
  assert.equal(cacheSize(), 0, 'a failed logout request cannot leave the lists behind');
});

test('a 401 from the server (session ended) empties the cache and signs the tab out', async () => {
  server();
  setToken(A);
  await fill();
  server({ status: 401, code: 'SESSION_INVALID' });
  await assert.rejects(api.get('/documents/expiring'));
  assert.equal(getToken(), null);
  assert.equal(cacheSize(), 0, 'the lists of the ended session are gone');
  assert.ok(peekSessionNotice(), 'and the login page will say why');
});

test('a 401 that only means "wrong code" does not end the session, and never fills the cache with the error', async () => {
  server();
  setToken(A);
  await fill();
  const size = cacheSize();
  server({ status: 401, code: 'INVALID_CODE' });
  await assert.rejects(api.get('/emergency/status', { skipSessionClear: true }));
  assert.equal(getToken(), A, 'the session is not the problem');
  assert.equal(cacheSize(), size, 'a failed read changes nothing in the cache');
});

test('a different account signing in in the same tab never sees the previous account’s lists', async () => {
  server();
  setToken(A);
  await fill();
  assert.deepEqual(peekDocuments(), [{ id: 'A-doc' }]);
  setToken(B);
  assert.equal(cacheSize(), 0);
  assert.equal(peekDocuments(), undefined);
  assert.equal(peekEmergencyStatus(), undefined);
  assert.deepEqual(await listDocuments(), [{ id: 'B-doc' }], 'B asks the server, it is not served A’s list');
});

test('an answer for account A that arrives after B signed in is thrown away, not stored for B', async () => {
  const net = server({ hold: true });
  setToken(A);
  const late = listDocuments();
  await new Promise((resolve) => setTimeout(resolve, 5));
  setToken(B);
  net.release();
  await late.catch(() => {});
  assert.equal(peekDocuments(), undefined, 'B starts with nothing from A');
});

test('session expiry empties the cache: by the server saying so, and by another tab ending the same session', async () => {
  server();
  setToken(A);
  await fill();
  expireSession();
  assert.equal(cacheSize(), 0);
  assert.equal(getToken(), null);

  globalThis.window = {};
  setToken(A);
  await fill();
  const other = new BroadcastChannel('warden-session');
  other.postMessage({ type: 'logout', token: A });
  await new Promise((resolve) => setTimeout(resolve, 50));
  other.close();
  delete globalThis.window;
  assert.equal(getToken(), null);
  assert.equal(cacheSize(), 0, 'the other tab’s sign-out empties this tab’s lists too');
});

test('the cache holds only the JSON lists of a fixed set of endpoints: never document bytes, thumbnails, keys or tokens', async () => {
  server();
  setToken(A);
  await fill();
  const held = JSON.stringify([peek('documents'), peek('insights/frequent'), peek('emergency/status'), peek('documents/expiring')]);
  assert.doesNotMatch(held, new RegExp(A.slice(0, 20)), 'no token in the cache');
  assert.doesNotMatch(held, /wrappedDEK|recoveryKey|sessionKey|encryptionKey|dataKey|base64/i);

  const allowed = ['auth/me', 'documents', 'documents/expiring', 'documents/folders', 'documents/folders/children', 'documents/recent', 'documents/details', 'emergency/status', 'insights/overview', 'insights/frequent', 'shares', 'trash'];
  const root = path.join(here, '..');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const uses = [];
  for (const file of walk(root).filter((f) => /\.(js|jsx)$/.test(f) && !/\.test\.js$/.test(f) && !f.endsWith('dataCache.js'))) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/fetchCached\(\s*[`'"]([^`'"$:]+)/g)) uses.push(match[1]);
  }
  assert.ok(uses.length >= 10);
  for (const key of uses) assert.ok(allowed.includes(key), `unexpected cached endpoint: ${key}`);
  const text = fs.readFileSync(path.join(root, 'services', 'dataCache.js'), 'utf8');
  assert.doesNotMatch(text.replace(/\/\*[\s\S]*?\*\//g, ''), /localStorage|sessionStorage|indexedDB|Blob|ArrayBuffer|crypto/);
});
