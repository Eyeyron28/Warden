import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..');

function files(dir = src, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files(full, out);
    else if (/\.(jsx|js)$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) out.push(full);
  }
  return out;
}
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const rel = (file) => path.relative(src, file).replace(/\\/g, '/');

test('GHSA-337j-9hxr-rhxg (deserializeErrors, server-side hydration): the app has no server rendering and no data router', () => {
  for (const file of files()) {
    const text = strip(fs.readFileSync(file, 'utf8'));
    assert.doesNotMatch(text, /createBrowserRouter|createMemoryRouter|createHashRouter|RouterProvider|StaticRouter|createStaticHandler|hydrateRoot|__staticRouterHydrationData|deserializeErrors/, rel(file));
  }
  const main = fs.readFileSync(path.join(src, 'main.jsx'), 'utf8');
  assert.match(main, /import \{ BrowserRouter \} from 'react-router-dom'/);
  assert.match(main, /createRoot\(/, 'the page is rendered in the browser only');
});

const REVIEWED = new Map([
  ['App.jsx', ['"/emergency?ended=1"', '"/login"']],
  ['components/emergency/EmergencyShell.jsx', ['{redirect}', '{item.to}']],
  ['components/site/SiteHeader.jsx', ['{link.to}']],
  ['components/VaultHealthCard.jsx', ['{fixPath(item)}']],
  ['pages/ExpiredPage.jsx', ['{openLink(doc)}']],
  ['pages/OverviewPage.jsx', ['{openLink(doc)}']],
  ['components/DriveList.jsx', ['{openLink(doc)}']],
  ['pages/ExportPage.jsx', ['{filesLink(job.destination)}']],
  ['components/TransferTray.jsx', ['row.actions.show', 'row.actions.review']],
  ['components/ImportCard.jsx', ['view.target']],
  ['pages/auth/LoginPage.jsx', ['landing']],
  ['components/FolderTree.jsx', ['path ? `/files?path=${encodeURIComponent(path']],
  ['pages/FilesPage.jsx', ['path ? `/files?path=${encodeURIComponent(path']],
]);

function dynamicTargets(text) {
  const found = [];
  for (const match of text.matchAll(/<(?:Link|NavLink|Navigate)\b[^>]*?\bto=(\{[^}]*\}|"[^"]*"|'[^']*')/g)) found.push(match[1]);
  for (const match of text.matchAll(/\bnavigate\(\s*([^,)]*(?:\([^)]*\))?[^,)]*)/g)) found.push(match[1].trim());
  return found.filter((target) => !/^\{?\s*["'`]\/([A-Za-z#?]|["'`]$)/.test(target));
}

test('GHSA-wrjc-x8rr-h8h6 (backslash open redirect): every computed navigation target is a reviewed one', () => {
  const seen = new Map();
  for (const file of files()) {
    const targets = dynamicTargets(strip(fs.readFileSync(file, 'utf8')));
    if (targets.length) seen.set(rel(file), [...new Set(targets)].sort());
  }
  for (const [file, targets] of seen) {
    const allowed = REVIEWED.get(file);
    assert.ok(allowed, `${file}: new computed navigation target(s) ${targets.join(', ')} (review them, then add them to REVIEWED and to docs/KNOWN-LIMITS.md)`);
    for (const target of targets) assert.ok(allowed.includes(target), `${file}: ${target} is not reviewed`);
  }
});

test('the one place a returned-to address comes from outside goes through the redirect guard', () => {
  const login = strip(fs.readFileSync(path.join(src, 'pages', 'auth', 'LoginPage.jsx'), 'utf8'));
  assert.match(login, /landingFor\(email\.trim\(\)\)/);
  assert.match(fs.readFileSync(path.join(src, 'services', 'visitMemory.js'), 'utf8'), /isSafeRedirectPath\(path\)/);
  assert.match(fs.readFileSync(path.join(src, 'utils', 'safeRedirect.js'), 'utf8'), /backslash/);
});
