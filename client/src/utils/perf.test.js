import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import api from '../services/api.js';
import { cacheSize, fetchCached, invalidateAll, peek } from '../services/dataCache.js';
import { clearToken, setToken } from '../services/session.js';
import { listDocuments, peekDocuments } from '../services/documentsService.js';
import { prefetchFirstScreen } from '../services/prefetch.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..');
const TOKEN = `${'a'.repeat(64)}.${'b'.repeat(64)}`;

// ---------- navigation never reloads the page ----------

function sourceFiles(dir = src, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(jsx|js)$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) out.push(full);
  }
  return out;
}
const code = (file) => fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const rel = (file) => path.relative(src, file).replace(/\\/g, '/');

test('no internal link is a plain <a href>: every one is a <Link> or <NavLink> (a plain anchor reloads the whole page)', () => {
  const bad = [];
  for (const file of sourceFiles()) {
    if (!file.endsWith('.jsx')) continue;
    const text = code(file);
    // <a ... href="/x" | href='/x' | href={"/x"} | href={`/x`} | href={'/x'}   (but not "//host", which is another site)
    for (const match of text.matchAll(/<a\b[^>]*\bhref=(?:"\/(?!\/)|'\/(?!\/)|\{\s*["'`]\/(?!\/))/g)) bad.push(`${rel(file)}: ${match[0].slice(0, 60)}`);
  }
  assert.deepEqual(bad, [], 'use <Link to="/..."> from react-router-dom for in-app links');
});

test('the page is never reloaded from code: window.location assignment is only for a mailto: link', () => {
  // a mailto: link, and the "Reload" buttons a person presses for a new version (never automatic)
  const allowed = new Map([
    ['pages/public/ContactSection.jsx', /window\.location\.href = mailto;/],
    ['components/UpdatePrompt.jsx', /window\.location\.reload\(\)/],
    ['components/RouteErrorBoundary.jsx', /window\.location\.reload\(\)/],
  ]);
  const bad = [];
  for (const file of sourceFiles()) {
    const text = code(file);
    for (const match of text.matchAll(/(window\.)?location\.(href\s*=|assign\(|replace\(|reload\()/g)) {
      const ok = allowed.get(rel(file))?.test(text.slice(match.index, match.index + 60));
      if (!ok) bad.push(`${rel(file)}: ${match[0]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('the signed-in frame is ONE parent route with an Outlet, and the Suspense for a page’s code is inside it', () => {
  const app = code(path.join(src, 'App.jsx'));
  assert.match(app, /<Route\s+element=\{\s*<RequireSession>\s*<SignedInShell onLocked=\{handleLocked\} \/>\s*<\/RequireSession>\s*\}\s*>/);
  const layout = code(path.join(src, 'components', 'AppLayout.jsx'));
  assert.match(layout, /<Suspense fallback=\{<PageSkeleton \/>\}>\s*<Outlet \/>\s*<\/Suspense>/, 'a page that is still loading hides only its own area');
  const pages = [...app.matchAll(/<Route path="\/(files|photos|shared|trash|export|overview|devices|account|emergency-access)"/g)].length;
  assert.equal(pages, 9, 'every signed-in page is a child of that one frame');
  // no page renders the frame itself
  for (const file of sourceFiles(path.join(src, 'pages'))) assert.doesNotMatch(code(file), /<(Header|Sidebar|AppLayout)\b/, rel(file));
});

test('while the stored session is checked the guard shows the frame’s skeleton, never a blank page, and checks once per load', () => {
  const app = code(path.join(src, 'App.jsx'));
  assert.match(app, /if \(!ready\) return <AppFrameSkeleton \/>;/);
  assert.doesNotMatch(app, /if \(!ready\) return null;/);
  assert.match(app, /function checkSessionOnce\(\) \{\s*if \(!sessionCheck\)/, 'once per page load (module level), not per navigation');
});

// ---------- the in-memory cache ----------

const fakeNetwork = () => {
  const seen = [];
  const pending = [];
  api.defaults.adapter = (config) => {
    seen.push(`${String(config.method).toUpperCase()} ${config.url}`);
    return new Promise((resolve) => {
      const answer = () => resolve({ data: config.url === '/documents' ? [{ id: 'd1' }] : config.url === '/insights/frequent' ? { items: [] } : [], status: 200, statusText: 'OK', headers: {}, config });
      pending.push(answer);
      if (!fakeNetwork.hold) answer();
    });
  };
  return { seen, release: () => pending.splice(0).forEach((answer) => answer()) };
};

test('one request per key at a time: callers share it, and the answer is remembered for the next page', async () => {
  invalidateAll();
  const net = fakeNetwork();
  const [a, b] = await Promise.all([listDocuments(), listDocuments()]);
  assert.deepEqual(a, b);
  assert.equal(net.seen.filter((line) => line === 'GET /documents').length, 1, 'two components asked, one request went out');
  assert.deepEqual(peekDocuments(), [{ id: 'd1' }], 'the next page starts from it');
  await listDocuments();
  assert.equal(net.seen.filter((line) => line === 'GET /documents').length, 2, 'and still refreshes in the background');
});

test('a write forgets every remembered list (successful or not), a read does not', async () => {
  invalidateAll();
  const net = fakeNetwork();
  await listDocuments();
  assert.ok(peekDocuments());
  await api.get('/something-else');
  assert.ok(peekDocuments(), 'a read leaves the cache alone');
  await api.post('/documents/folders', { name: 'x' });
  assert.equal(peekDocuments(), undefined, 'a write forgets it');
  assert.equal(cacheSize(), 0);

  await listDocuments();
  assert.ok(peekDocuments());
  api.defaults.adapter = (config) => Promise.reject(Object.assign(new Error('boom'), { config, response: { status: 500, data: {} } }));
  await api.delete('/documents/abc').catch(() => {});
  assert.equal(peekDocuments(), undefined, 'a write that failed may still have changed something');
  assert.ok(net.seen.length > 0);
});

test('an answer that was in flight when a write happened is thrown away, not stored', async () => {
  invalidateAll();
  fakeNetwork.hold = true;
  const net = fakeNetwork();
  const slowRead = listDocuments();
  await new Promise((resolve) => setTimeout(resolve, 5));
  fakeNetwork.hold = false;
  await api.patch('/documents/d1', { filename: 'new' }); // the write lands while the read is out
  net.release();
  await slowRead;
  assert.equal(peekDocuments(), undefined, 'the old list is never remembered after the write');
});

test('the cache is emptied whenever the session changes, so one session never sees another’s lists', async () => {
  invalidateAll();
  fakeNetwork();
  setToken(TOKEN);
  await listDocuments();
  assert.ok(peekDocuments());
  clearToken();
  assert.equal(peekDocuments(), undefined, 'signing out empties it');
  await listDocuments();
  setToken(`${'c'.repeat(64)}.${'d'.repeat(64)}`);
  assert.equal(peekDocuments(), undefined, 'so does a different sign-in');
  clearToken();
});

test('maxAgeMs reuses a young answer without a request; 0 always asks', async () => {
  invalidateAll();
  let calls = 0;
  const load = async () => ++calls;
  assert.equal(await fetchCached('k', load, { maxAgeMs: 30000 }), 1);
  assert.equal(await fetchCached('k', load, { maxAgeMs: 30000 }), 1);
  assert.equal(await fetchCached('k', load), 2);
  assert.equal(peek('k'), 2);
});

test('only JSON answers are remembered: nothing in the cache layer touches document bytes, thumbnails or keys', () => {
  const text = code(path.join(src, 'services', 'dataCache.js'));
  assert.doesNotMatch(text, /localStorage|sessionStorage|indexedDB|blob|arrayBuffer|crypto/i);
  for (const file of ['documentsService.js']) {
    const service = code(path.join(src, 'services', file));
    // the byte and thumbnail downloads do not go through the cache
    assert.doesNotMatch(service, /fetchCached\([^)]*(view|thumbnail)/);
  }
});

// ---------- the first screen asks in parallel with the session check ----------

test('on /files the first screen’s requests all go out at once, and the page shares them', async () => {
  invalidateAll();
  fakeNetwork.hold = true;
  const net = fakeNetwork();
  setToken(TOKEN);
  prefetchFirstScreen('/files');
  await new Promise((resolve) => setTimeout(resolve, 5));
  // all in the air before any has answered (the old order: one, then the page renders, then the rest)
  assert.deepEqual(
    [...net.seen].sort(),
    ['GET /auth/me', 'GET /documents', 'GET /documents/expiring', 'GET /documents/folders', 'GET /documents/folders/children', 'GET /emergency/status', 'GET /insights/frequent'].sort()
  );
  const before = net.seen.length;
  const shared = listDocuments(); // the page asks for the same list
  assert.equal(net.seen.length, before, 'it joins the request already out');
  fakeNetwork.hold = false;
  net.release();
  await shared;
  clearToken();
});

test('no stored session, an unknown page, or an Emergency Access tab: nothing is requested early', () => {
  invalidateAll();
  const net = fakeNetwork();
  clearToken();
  prefetchFirstScreen('/files');
  assert.deepEqual(net.seen, []);
  setToken(TOKEN);
  prefetchFirstScreen('/account');
  assert.deepEqual(net.seen, []);
  clearToken();
  const prefetch = code(path.join(src, 'services', 'prefetch.js'));
  assert.match(prefetch, /if \(!getToken\(\) \|\| wasEmergencyTab\(\)\) return;/);
});

test('the app starts the prefetch before it renders', () => {
  const main = code(path.join(src, 'main.jsx'));
  assert.ok(main.indexOf('prefetchFirstScreen(window.location.pathname)') < main.indexOf('createRoot('));
});

test('Emergency banner reuses an answer for 30 seconds on a page change; its minute timer always asks', () => {
  const banner = code(path.join(src, 'components', 'EmergencyBanner.jsx'));
  assert.match(banner, /maxAgeMs: fresh \? 0 : 30 \* 1000/);
  assert.match(banner, /setInterval\(\(\) => load\(\{ fresh: true \}\), POLL_MS\)/);
});

import { isChunkFailure } from './chunkFailure.js';

test('a page that throws, or whose code cannot be fetched, stays inside its own area (the frame is not taken down)', () => {
  const layout = code(path.join(src, 'components', 'AppLayout.jsx'));
  assert.match(layout, /<RouteErrorBoundary resetKey=\{location\.pathname\}>\s*<Suspense/);
  assert.match(code(path.join(src, 'components', 'site', 'PublicLayout.jsx')), /<RouteErrorBoundary resetKey=\{pathname\}>/);
  const boundary = code(path.join(src, 'components', 'RouteErrorBoundary.jsx'));
  assert.match(boundary, /static getDerivedStateFromError/);
  assert.match(boundary, /previous\.resetKey !== this\.props\.resetKey/, 'moving to another page clears the error');
  assert.doesNotMatch(boundary, /window\.location\.reload\(\);\s*\}\s*,/, 'no automatic reload');
});

test('the failures an old tab gets after a new deployment are recognised', () => {
  for (const message of [
    'Failed to fetch dynamically imported module: https://x.test/assets/FilesPage-abc.js',
    'error loading dynamically imported module',
    'Importing a module script failed.',
    'Loading chunk 12 failed.',
    "Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of \"text/html\"",
  ]) assert.equal(isChunkFailure(new Error(message)), true, message);
  assert.equal(isChunkFailure(new Error('Cannot read properties of undefined')), false);
});

import { FIRST_ROWS, ROWS_PER_STEP, nextRenderCount } from './useProgressiveList.js';

test('a long list is drawn in steps: a first screenful at once, every row in the end, no row ever lost', () => {
  assert.ok(FIRST_ROWS >= 20 && FIRST_ROWS <= 60, 'enough for the first screen, small enough to be instant');
  let count = FIRST_ROWS;
  const steps = [];
  while (count < 2000) {
    count = nextRenderCount(count, 2000);
    steps.push(count);
  }
  assert.equal(count, 2000, 'all of them, in the end');
  assert.ok(steps.every((value, index) => index === 0 || value > steps[index - 1]), 'always forward');
  assert.ok(steps.length < 30, 'a handful of steps');
  assert.equal(nextRenderCount(10, 20), 20, 'never past the end');
  assert.equal(nextRenderCount(0, 5), 5);
  assert.equal(ROWS_PER_STEP > 0, true);
});

test('both the list and the grid draw through the progressive list, and the data handed to the page is never cut', () => {
  const browser = code(path.join(src, 'components', 'FileBrowser.jsx'));
  assert.match(browser, /const shownItems = useProgressiveList\(items\);/);
  assert.equal((browser.match(/shownItems\.map\(/g) || []).length, 2, 'grid and list');
  assert.doesNotMatch(browser, /items\.map\(/, 'no path renders every item at once');
  const files = code(path.join(src, 'pages', 'FilesPage.jsx'));
  assert.doesNotMatch(files, /useProgressiveList/, 'the page keeps working on the full data (search, select all)');
});
