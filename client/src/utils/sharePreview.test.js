import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SHARE_DESCRIPTION, SHARE_TITLE, makeSharePreview } from '../../scripts/make-share-preview.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..');
const indexHtml = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');

test('the share-link preview page says only that a document was shared: no file name, purpose or owner', () => {
  const html = makeSharePreview(indexHtml);
  assert.match(html, /<title>Warden — a document was shared with you<\/title>/);
  assert.match(html, /<meta property="og:title" content="Warden — a document was shared with you" \/>/);
  assert.ok(html.includes(`<meta property="og:description" content="${SHARE_DESCRIPTION}" />`));
  assert.ok(html.includes(`<meta name="description" content="${SHARE_DESCRIPTION}" />`));
  assert.match(html, /<meta property="og:site_name" content="Warden" \/>/);
  assert.match(html, /<meta name="twitter:card" content="summary" \/>/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow" \/>/);
  assert.equal(SHARE_TITLE, 'Warden — a document was shared with you');
  // the only image is the fixed app icon: no per-share or user image
  const images = [...html.matchAll(/<meta[^>]+(?:og|twitter):image[^>]*content="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(images, ['/icons/icon-512.png']);
  // nothing else about the page changed: the same inline theme script (the CSP allows it by hash) and the same app
  const script = (text) => /<script>([\s\S]*?)<\/script>/.exec(text)[1];
  assert.equal(script(html), script(indexHtml));
});

test('the generator refuses to run on a page it does not understand', () => {
  assert.throws(() => makeSharePreview('<html><head></head></html>'), /not found/);
});

test('vercel.json serves that page for /shared/*, after the API and before the catch-all', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const sources = config.rewrites.map((r) => r.source);
  const shared = config.rewrites.find((r) => r.source === '/shared/(.*)');
  assert.equal(shared.destination, '/shared-preview.html');
  assert.ok(sources.indexOf('/api/(.*)') < sources.indexOf('/shared/(.*)'));
  assert.ok(sources.indexOf('/shared/(.*)') < sources.indexOf('/(.*)'));
  assert.match(JSON.parse(fs.readFileSync(path.join(root, 'client', 'package.json'), 'utf8')).scripts.build, /make-share-preview\.mjs/);
});

test('the key after # is never sent to Warden: the share API helpers take no key, and nothing reads the fragment into a request', () => {
  const src = (...p) => fs.readFileSync(path.join(root, 'client', 'src', ...p), 'utf8');
  const service = src('services', 'sharedService.js');
  assert.doesNotMatch(service, /location\.hash|readKeyFromHash|keyText|#k=/);
  const page = src('pages', 'SharedDocumentPage.jsx');
  // the fragment is read once and kept in memory; it is removed from the address bar
  assert.match(page, /readKeyFromHash\(window\.location\.hash\)/);
  assert.match(page, /replaceState\(null, ''/);
  // none of the calls that reach the server is handed the key
  for (const call of page.matchAll(/\b(openAccess|fetchSharedManifest|requestEmailCode|verifyEmailCode|fetchSharedFile|downloadSharedFile)\(([^)]*)\)/g)) {
    assert.doesNotMatch(call[2], /keyText|shareKey|key\b/i, call[0]);
  }
  // and the share link helpers never put the key in a query string
  const links = src('utils', 'shareLinks.js');
  assert.doesNotMatch(links, /\?k=|&k=/);
});
