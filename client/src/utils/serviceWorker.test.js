import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', '..', 'public', 'service-worker.js'), 'utf8');

test('the service worker is stamped per build, so every deployment replaces it', () => {
  assert.match(source, /const BUILD_ID = '__BUILD_ID__'/);
  assert.match(source, /warden-shell-\$\{BUILD_ID\}/);
  assert.match(source, /skipWaiting\(\)/);
  assert.match(source, /clients\.claim\(\)/);
});

test('the page is never served cache-first, and the API is never touched', () => {
  // "/" and the shell are not precached as the answer to a request; navigations go to the network first.
  assert.match(source, /request\.mode === 'navigate'[\s\S]*fetch\(request\)[\s\S]*\.catch\(\(\) => caches\.match\(SHELL\)\)/);
  assert.match(source, /BYPASS_PREFIXES = \['\/api\/', '\/shared\/'\]/);
  assert.match(source, /BYPASS_PREFIXES\.some\(\(prefix\) => url\.pathname\.startsWith\(prefix\)\)\) return/);
  // Cache-first only for the content-hashed bundle files.
  const cacheFirst = source.slice(source.indexOf("startsWith('/assets/')"));
  assert.match(cacheFirst, /cached \|\| fetch/);
});

// ---- behaviour: the real worker file, run against a fake browser ----

function runWorker() {
  const listeners = {};
  const stored = new Map(); // what the worker put in the cache: url -> response
  const cache = { put: async (request, response) => stored.set(typeof request === 'string' ? request : request.url, response), addAll: async () => {} };
  const caches = {
    open: async () => cache,
    match: async (request) => stored.get(typeof request === 'string' ? request : request.url),
    keys: async () => [],
    delete: async () => true,
  };
  const network = [];
  const fetchStub = async (request) => {
    network.push(request.url);
    const headers = new Map();
    const url = new URL(request.url);
    if (url.searchParams.get('cc')) headers.set('cache-control', url.searchParams.get('cc'));
    const response = { ok: true, status: 200, url: request.url, headers: { get: (name) => headers.get(name.toLowerCase()) ?? null } };
    response.clone = () => ({ ...response, clone: response.clone });
    return response;
  };
  const self = { location: new URL('https://warden.test/'), addEventListener: (type, fn) => { listeners[type] = fn; }, skipWaiting() {}, clients: { claim: async () => {} } };
  vm.runInNewContext(source, { self, caches, fetch: fetchStub, URL, Promise });
  const fetchEvent = (url, { method = 'GET', mode = 'cors' } = {}) => {
    const event = { request: { url, method, mode }, answered: false, respondWith(promise) { this.answered = true; this.promise = Promise.resolve(promise); } };
    listeners.fetch(event);
    return event;
  };
  return { fetchEvent, stored, network };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the worker leaves /shared/* and /api/* to the browser: no answer, no network call of its own, nothing stored', async () => {
  const { fetchEvent, stored, network } = runWorker();
  for (const url of ['https://warden.test/shared/abc123', 'https://warden.test/shared/abc123/files/1', 'https://warden.test/api/documents', 'https://warden.test/api/shared/abc123']) {
    for (const mode of ['navigate', 'cors', 'no-cors']) {
      const event = fetchEvent(url, { mode });
      assert.equal(event.answered, false, `${mode} ${url} is not intercepted`);
    }
  }
  await settle();
  assert.equal(stored.size, 0);
  assert.equal(network.length, 0);
});

test('the worker still serves the shell for ordinary pages and keeps hashed assets', async () => {
  const { fetchEvent, stored } = runWorker();
  const page = fetchEvent('https://warden.test/documents', { mode: 'navigate' });
  assert.equal(page.answered, true);
  await page.promise;
  await settle();
  assert.ok(stored.has('/index.html'), 'the newest shell is kept for offline');
  const asset = fetchEvent('https://warden.test/assets/index-abc123.js');
  assert.equal(asset.answered, true);
  await asset.promise;
  await settle();
  assert.ok(stored.has('https://warden.test/assets/index-abc123.js'));
});

test('a response that says no-store or private is never kept; other methods and origins are ignored', async () => {
  const { fetchEvent, stored } = runWorker();
  for (const cc of ['no-store', 'private, max-age=60', 'No-Store']) {
    const event = fetchEvent(`https://warden.test/something.json?cc=${encodeURIComponent(cc)}`);
    await event.promise;
  }
  await settle();
  assert.equal(stored.size, 0);
  assert.equal(fetchEvent('https://warden.test/documents', { method: 'POST', mode: 'navigate' }).answered, false);
  assert.equal(fetchEvent('https://elsewhere.test/x.js').answered, false);
});
