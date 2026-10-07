import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
  assert.match(source, /startsWith\('\/api\/'\)\) return/);
  // Cache-first only for the content-hashed bundle files.
  const cacheFirst = source.slice(source.indexOf("startsWith('/assets/')"));
  assert.match(cacheFirst, /cached \|\| fetch/);
});
