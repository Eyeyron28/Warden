import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const exists = (...parts) => fs.existsSync(path.join(root, ...parts));

test('lint and the responsive check are scripts, with a config each (dev dependencies only)', () => {
  for (const pkg of ['client', 'server']) {
    const json = JSON.parse(read(pkg, 'package.json'));
    assert.equal(json.scripts.lint, 'eslint .', pkg);
    assert.ok(json.devDependencies.eslint, `${pkg}: eslint is a dev dependency`);
    assert.ok(!json.dependencies?.eslint, `${pkg}: not a runtime dependency`);
    assert.ok(exists(pkg, 'eslint.config.js'), pkg);
  }
  const client = JSON.parse(read('client', 'package.json'));
  assert.equal(client.scripts['check:responsive'], 'node scripts/check-responsive.mjs');
  assert.ok(client.devDependencies['playwright-core'] && !client.dependencies?.['playwright-core'], 'the driver is a dev dependency and downloads no browser');
  const script = read('client', 'scripts', 'check-responsive.mjs');
  assert.match(script, /must point at a local MongoDB/);
  assert.match(script, /dotenv/, 'no .env is read');
  assert.doesNotMatch(script, /playwright install/);
  for (const width of ["'360'", "'768'", "'1280'"]) assert.ok(script.includes(width), width);
  for (const page of ["'/files'", "'/overview'", "'/devices'", "'/trash'", "'/shared'"]) assert.ok(script.includes(page), page);
});

test('the two unused files are gone and nothing refers to them', () => {
  for (const file of [['client', 'src', 'components', 'FolderTile.jsx'], ['client', 'src', 'components', 'FolderTile.module.css'], ['client', 'src', 'utils', 'documentSort.js']]) assert.ok(!exists(...file), file.join('/'));
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]));
  for (const file of walk(path.join(root, 'client', 'src')).filter((f) => /\.(jsx?|css)$/.test(f) && !f.endsWith('hygiene.test.js'))) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /FolderTile|documentSort/, file);
  }
});

test('the committed test notes hold no token, key, password, hash, address or local path', () => {
  const notes = read('test-results', 'checkpoint2-security-tests.md');
  assert.doesNotMatch(notes, /[0-9a-f]{32,}/i, 'no token or long hash');
  assert.doesNotMatch(notes, /\b[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}\b/, 'no recovery key');
  assert.doesNotMatch(notes, /\b(?!127\.0\.0\.1)\d{1,3}(?:\.\d{1,3}){3}\b/, 'no IP address but localhost');
  assert.doesNotMatch(notes, /C:\\Users\\|Xk9!/, 'no local path or password');
  assert.doesNotMatch(notes, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, 'no email address');
  assert.match(notes, /Historic snapshot, 2026-09-22, redacted/);
  const ignore = read('.gitignore');
  assert.match(ignore, /^test-results\/\*$/m);
  assert.match(ignore, /^!test-results\/\*\.md$/m, 'the notes (and only the notes) are tracked');
});

test('docs/KNOWN-LIMITS.md records both react-router advisories and how they were checked', () => {
  const text = read('docs', 'KNOWN-LIMITS.md');
  for (const id of ['GHSA-wrjc-x8rr-h8h6', 'GHSA-337j-9hxr-rhxg']) assert.ok(text.includes(id), id);
  assert.match(text, /safeRedirectPath/);
  assert.match(text, /router-advisory\.test\.js/);
  assert.match(text, /react-router-dom@7\.18\.4/);
});

test('the file list picks its row layout from its own width, so four columns beside the sidebar cannot scroll the page', () => {
  const css = read('client', 'src', 'components', 'FileBrowser.module.css');
  assert.match(css, /container-type: inline-size/);
  assert.match(css, /@container \(min-width: 820px\)[\s\S]*\.row\.manyCols/);
});
