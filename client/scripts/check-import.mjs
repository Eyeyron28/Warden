// node scripts/check-import.mjs   (from client, after "npm run build"; DIST_DIR=<another build> to try another one)
//
// Drives the background zip import in a real browser against the real app on a LOCAL throwaway MongoDB (127.0.0.1:27099, or a
// local WARDEN_TEST_MONGO; no .env is read; mail is captured), served with the production CSP. A zip of 20 small files is imported
// (each upload is held back a little so there is time to move around), and the run checks that:
//   - the import keeps going across Files, Overview, Devices, Trash and Shared, the card is on every page and its counter advances;
//   - clicking the card goes to the Import screen; at the end the card shows the check, and a click opens the destination folder;
//   - an unclicked finished card disappears after the (shortened) time, and the report stays on the Import screen;
//   - "Lock vault" asks first, "Keep importing" changes nothing, "Stop and sign out" ends it and leaves nothing behind;
//   - closing or reloading the tab during a run shows the browser's own warning;
//   - nothing is written to localStorage, IndexedDB or the cache, and there are no CSP violations.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';
import JSZip from 'jszip';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const dist = process.env.DIST_DIR ? path.resolve(process.env.DIST_DIR) : path.join(root, 'client', 'dist');
const requireServer = createRequire(path.join(root, 'server', 'package.json'));
const SHOTS = process.env.SHOTS || '';
const CARD_MS = 4000; // the shortened dismiss time for the unclicked card
const HOLD_MS = 650; // each upload is held this long, so a run of 20 takes several seconds

const baseUri = process.env.WARDEN_TEST_MONGO || 'mongodb://127.0.0.1:27099/?replicaSet=rs0&directConnection=true';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(baseUri)) {
  console.error('WARDEN_TEST_MONGO must point at a local MongoDB. Refusing.');
  process.exit(2);
}
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('the build is missing. Run "npm run build" first.');
  process.exit(2);
}
const uri = baseUri.replace(/^(mongodb:\/\/[^/]+)\/[^?]*/, '$1/warden_import_check');

const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const CSP = JSON.stringify(vercel)
  .match(/"Content-Security-Policy","value":"(default-src 'self'[^"]+)"/)?.[1]
  .replace('; upgrade-insecure-requests', '');
if (!CSP) throw new Error('could not find the app Content-Security-Policy in vercel.json');

const load = Module._load;
Module._load = function stubbed(request, ...rest) {
  return request === 'dotenv' ? { config: () => ({}), parse: () => ({}) } : load.call(this, request, ...rest);
};
for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM', 'VERCEL', 'INVITE_CODE', 'CRON_SECRET']) delete process.env[name];
Object.assign(process.env, { NODE_ENV: 'test', MONGO_URI: uri, SIGNUP_MODE: 'open', OTP_ENABLED: 'false', PUBLIC_APP_URL: 'https://warden.test', EMERGENCY_DEMO_MODE: 'false', STORAGE_QUOTA_MB: '200', CORS_ORIGINS: 'http://127.0.0.1:5063' });
requireServer('dns').promises.resolveMx = async () => [{ exchange: 'mx.example.test', priority: 10 }];
const mails = [];
const emailPath = requireServer.resolve('./utils/email');
const realEmail = requireServer('./utils/email');
requireServer.cache[emailPath].exports = { ...realEmail, sendEmail: async (message) => { mails.push(message); return true; } };

const app = requireServer('./server.js');
const mongoose = requireServer('mongoose');
await requireServer('./config/db')();
await mongoose.connection.dropDatabase();
await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api')) return app(req, res);
  let file = path.join(dist, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  res.setHeader('Content-Security-Policy', CSP);
  return res.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(5063, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:5063';

async function api(method, route, { token, json } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  let body;
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  await mongoose.models.RateLimit.deleteMany({});
  const response = await fetch(base + route, { method, headers, body });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* none */ }
  return { status: response.status, body: parsed };
}

const problems = [];
const check = (ok, message) => {
  console.log(`${ok ? 'ok   ' : 'FAIL '} ${message}`);
  if (!ok) problems.push(message);
};

async function launch() {
  const attempts = [process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}, { channel: 'chrome' }, { channel: 'msedge' }];
  let last;
  for (const options of attempts) {
    try { return await chromium.launch({ headless: true, ...options }); } catch (error) { last = error; }
  }
  throw new Error(`No Chromium found: ${String(last?.message).split('\n')[0]}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-import-'));
async function makeZip(name, count, top = 'Backup') {
  const zip = new JSZip();
  for (let i = 1; i <= count; i += 1) zip.file(`${top}/part${i % 4}/note-${i}.txt`, `note number ${i} `.repeat(30));
  const file = path.join(tmp, name);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'uint8array' }));
  return file;
}

let browser;
try {
  const email = 'import.check@example.com';
  const password = 'Qx7!vTr29#mLpw';
  await api('POST', '/api/auth/signup/start', { json: { email, password, termsAccepted: true } });
  const code = /(?<![\d-])(\d{6})(?![\d-])/.exec(mails.at(-1).text)[1];
  const token = (await api('POST', '/api/auth/signup/verify', { json: { email, password, code } })).body.sessionToken;
  const docCount = async () => (await api('GET', '/api/documents', { token })).body.length;

  browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  await context.addInitScript(([value, ms]) => {
    try { window.sessionStorage.setItem('warden.session', value); } catch { /* none */ }
    window.__WARDEN_TEST__ = { importCardMs: ms };
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
  }, [token, CARD_MS]);
  // Hold every upload back a little (the server is fast on a local machine; a real one is not).
  await context.route('**/api/documents', async (route) => {
    if (route.request().method() === 'POST') await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    await route.continue();
  });
  const page = await context.newPage();
  const consoleProblems = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleProblems.push(message.text()); });
  page.on('pageerror', (error) => consoleProblems.push(`pageerror: ${error.message}`));
  const card = page.getByTestId('transfer-tray');
  const nav = (name) => page.getByRole('link', { name, exact: true }).first();
  const counter = async () => {
    const text = await card.innerText();
    const match = /(\d+) of (\d+) files/.exec(text);
    return match ? Number(match[1]) : null;
  };

  await page.goto(`${base}/export`);
  const zipFile = await makeZip('backup.zip', 20);
  await page.locator('input[aria-label="Choose a .zip to import"]').setInputFiles(zipFile);
  await page.getByRole('button', { name: /^Import 20 files$/ }).click();
  await card.waitFor({ timeout: 10000 });
  check(true, 'the card appears as soon as the import starts');
  check(/Importing 20 files/.test(await card.innerText()) && /backup\.zip/.test(await card.innerText()), 'it says "Importing 20 files" with backup.zip as a row');
  check((await page.getByRole('button', { name: /^Choose a \.zip/ }).count()) === 0, 'a second zip cannot be chosen while one runs (the choose button is gone)');

  // ---- moving around: the import must keep going ----
  let last = -1;
  let advanced = false;
  for (const [label, expectPath] of [['My files', '/files'], ['Overview', '/overview'], ['Devices & activity', '/devices'], ['Trash', '/trash'], ['Shared', '/shared']]) {
    await nav(label).click();
    await page.waitForURL((url) => url.pathname === expectPath, { timeout: 8000 });
    await page.waitForTimeout(900);
    const visible = await card.isVisible();
    const n = await counter();
    check(visible, `${expectPath}: the card is on the page`);
    check(n !== null && n >= last, `${expectPath}: the counter is "${n} of 20" (never goes back from ${last})`);
    if (n !== null && n > last && last >= 0) advanced = true;
    if (n !== null) last = n;
    if (SHOTS && expectPath === '/overview') await page.screenshot({ path: path.join(SHOTS, 'import-card-running.png') });
  }
  check(advanced, 'the counter kept advancing while the pages changed');
  const mid = await docCount();
  check(mid > 0 && mid < 20, `files are arriving on the server while the person is elsewhere (${mid} of 20 so far)`);

  // ---- clicking the running card opens the Import screen ----
  await card.getByRole('button', { name: /^Show details/ }).click();
  await page.waitForURL((url) => url.pathname === '/export');
  check(await page.getByTestId('import-progress').isVisible(), '"Show details" on the running row opens the Import screen, which shows the full progress');

  // ---- the end ----
  await page.getByText(/20 files sealed/).first().waitFor({ timeout: 30000 });
  check((await docCount()) === 20, 'all 20 files are in the vault');
  check((await card.getAttribute('data-state')) === 'done', 'the tray changes to the done state (sealed lock)');
  check(/20 files sealed/.test(await card.innerText()), 'it says "20 files sealed"');
  check((await card.getByRole('button', { name: /^Dismiss/ }).count()) === 1, 'the finished import row has Dismiss');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'import-card-done.png') });
  await nav('Overview').click();
  await page.waitForURL((url) => url.pathname === '/overview');
  await card.getByRole('button', { name: /^Show .* in its folder/ }).click();
  await page.waitForURL((url) => url.pathname === '/files' && url.searchParams.get('path') === 'Backup');
  await page.getByRole('heading', { name: /^Folders/ }).or(page.getByRole('heading', { name: /^Files/ })).first().waitFor();
  await page.waitForTimeout(800);
  const folderCards = await page.locator('ul[aria-label="Folders"] > li').count();
  check(folderCards >= 4, `clicking the done card opens the destination folder "Backup" (it holds ${folderCards} sub-folders with the files)`);
  
  // ---- an unclicked finished card goes away by itself; the report stays ----
  const second = await makeZip('second.zip', 6, 'Backup');
  await nav('Export').click();
  await page.waitForURL((url) => url.pathname === '/export');
  check(await page.getByTestId('import-report').isVisible(), 'the last import\'s report is still on the Import screen after the card was dismissed');
  await page.locator('input[aria-label="Choose a .zip to import"]').setInputFiles(second);
  await page.getByRole('button', { name: /^Import 6 files$/ }).click();
  await nav('Trash').click();
  await page.getByText(/6 files sealed/).first().waitFor({ timeout: 30000 });
  const finishedAt = Date.now();
  await card.waitFor({ state: 'detached', timeout: CARD_MS + 8000 });
  const stayed = Date.now() - finishedAt;
  check(stayed >= CARD_MS - 1200 && stayed <= CARD_MS + 3000, `an unclicked finished card disappears after the shortened time (${stayed} ms, set to ${CARD_MS} ms)`);
  await nav('Export').click();
  check(await page.getByTestId('import-report').isVisible(), 'the report is still there after the card has gone');
  check((await docCount()) === 26, 'the second import added its 6 files (names already in use got a number)');
  const names = (await api('GET', '/api/documents', { token })).body.map((doc) => doc.filename);
  check(names.some((name) => /note-1 \(1\)\.txt$/.test(name)), 'a name already in use was imported with a counter, e.g. "note-1 (1).txt"');

  // ---- Lock vault asks first ----
  const third = await makeZip('third.zip', 20, 'Third');
  await page.locator('input[aria-label="Choose a .zip to import"]').setInputFiles(third);
  await page.getByRole('button', { name: /^Import 20 files$/ }).click();
  await card.waitFor();
  await nav('Overview').click();
  await page.getByRole('button', { name: 'Lock vault' }).click();
  const ask = page.getByRole('dialog', { name: 'Stop and sign out?' });
  await ask.waitFor();
  check(/An import is running\. Stop it and sign out\?/.test(await ask.innerText()), 'Lock vault asks: "An import is running. Stop it and sign out?"');
  await ask.getByRole('button', { name: 'Keep going' }).click();
  await ask.waitFor({ state: 'detached' });
  check(page.url().includes('/overview') && (await card.isVisible()), '"Keep going" leaves the person signed in and the import running');
  const before = await counter();
  await page.waitForTimeout(1500);
  check((await counter()) > before, 'and it keeps advancing');

  // ---- the browser's own warning when the tab is closed or reloaded during a run ----
  const warned = page.waitForEvent('dialog', { timeout: 8000 }).then((dialog) => ({ type: dialog.type(), dialog }));
  page.reload().catch(() => {});
  const seen = await warned.catch(() => null);
  check(seen?.type === 'beforeunload', `reloading during an import shows the browser's "leave this page?" warning (${seen?.type ?? 'no dialog'})`);
  if (seen) await seen.dialog.dismiss();

  // ---- Stop and sign out: nothing is left behind ----
  await page.getByRole('button', { name: 'Lock vault' }).click();
  await ask.waitFor();
  await ask.getByRole('button', { name: 'Stop and sign out' }).click();
  await page.waitForURL((url) => url.pathname === '/login', { timeout: 10000 });
  check((await card.count()) === 0, 'after "Stop and sign out" there is no card on the login page');
  const leftover = await page.evaluate(async () => ({
    session: Object.keys(window.sessionStorage),
    local: Object.keys(window.localStorage),
    idb: indexedDB.databases ? (await indexedDB.databases()).map((db) => db.name) : [],
    text: document.body.innerText,
  }));
  check(leftover.session.length === 0 && leftover.local.length === 0 && leftover.idb.length === 0, `no session token, no localStorage, no IndexedDB (${JSON.stringify({ s: leftover.session, l: leftover.local, i: leftover.idb })})`);
  check(!/third\.zip|Third|note-/.test(leftover.text), 'no file or zip name is left on the page');
  const importedThird = (await api('GET', '/api/documents', { token })).status; // the old token is dead
  check(importedThird === 401, 'the signed-out session is really over on the server');
  const csp = await page.evaluate(() => window.__csp).catch(() => []);
  check(csp.length === 0, `no CSP violations (${csp.join('; ') || 'none'})`);
  const bad = consoleProblems.filter((line) => /content security policy|refused to|violat/i.test(line));
  check(bad.length === 0, `no CSP errors in the console${bad.length ? `: ${bad.join(' | ')}` : ''}`);
  if (consoleProblems.length) console.log(`console errors (all): ${consoleProblems.length}\n  ${consoleProblems.slice(0, 5).join('\n  ')}`);
} catch (error) {
  console.error(error);
  problems.push(`script error: ${error.message}`);
} finally {
  await browser?.close();
  server.close();
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(problems.length ? `\n${problems.length} problem(s).` : '\nAll checks passed.');
process.exit(problems.length ? 1 : 0);
