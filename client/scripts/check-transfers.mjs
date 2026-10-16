// node scripts/check-transfers.mjs   (from client, after "npm run build"; DIST_DIR=<another build> to try another one)
//
// Drives the transfer tray in a real browser against the real app on a LOCAL throwaway MongoDB (127.0.0.1:27099, or a local
// WARDEN_TEST_MONGO; no .env is read; mail is captured), served with the production CSP. Uploads are held back by the script, so the
// states in between can be looked at. It checks that: one click is one row and one file (a double click too); the tray follows the
// person across pages; Cancel works; a too-large file is refused in the dialog; a failed upload shows Retry and the retry makes exactly
// one file; two files at once; a new version and a dropped file use the tray; the zip import is a row; no CSP violations.
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
const TRAY_MS = 3000; // the shortened dismiss time

const baseUri = process.env.WARDEN_TEST_MONGO || 'mongodb://127.0.0.1:27099/?replicaSet=rs0&directConnection=true';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(baseUri)) {
  console.error('WARDEN_TEST_MONGO must point at a local MongoDB. Refusing.');
  process.exit(2);
}
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('the build is missing. Run "npm run build" first.');
  process.exit(2);
}
const uri = baseUri.replace(/^(mongodb:\/\/[^/]+)\/[^?]*/, '$1/warden_transfers_check');

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
Object.assign(process.env, { NODE_ENV: 'test', MONGO_URI: uri, SIGNUP_MODE: 'open', OTP_ENABLED: 'false', PUBLIC_APP_URL: 'https://warden.test', EMERGENCY_DEMO_MODE: 'false', STORAGE_QUOTA_MB: '200', CORS_ORIGINS: 'http://127.0.0.1:5065' });
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
await new Promise((resolve) => server.listen(5065, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:5065';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-transfers-'));
async function makeZip(name, count, top = 'Backup') {
  const zip = new JSZip();
  for (let i = 1; i <= count; i += 1) zip.file(`${top}/part${i % 4}/note-${i}.txt`, `note number ${i} `.repeat(30));
  const file = path.join(tmp, name);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'uint8array' }));
  return file;
}

let browser;
try {
  const email = 'transfers.check@example.com';
  const password = 'Qx7!vTr29#mLpw';
  await api('POST', '/api/auth/signup/start', { json: { email, password, termsAccepted: true } });
  const code = /(?<![\d-])(\d{6})(?![\d-])/.exec(mails.at(-1).text)[1];
  const token = (await api('POST', '/api/auth/signup/verify', { json: { email, password, code } })).body.sessionToken;
  const docs = async () => (await api('GET', '/api/documents', { token })).body;
  const named = async (re) => (await docs()).filter((doc) => re.test(doc.filename));

  browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  await context.addInitScript(([value, ms]) => {
    try { window.sessionStorage.setItem('warden.session', value); } catch { /* none */ }
    window.__WARDEN_TEST__ = { importCardMs: ms };
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
  }, [token, TRAY_MS]);

  // The script decides what happens to each upload: held (released later), failed once, or let through at once.
  const gate = { mode: 'pass', held: [], posts: 0, failNext: 0 };
  await context.route('**/api/documents', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    gate.posts += 1;
    if (gate.failNext > 0) { gate.failNext -= 1; return route.abort('failed'); }
    if (gate.mode === 'hold') return new Promise((resolve) => gate.held.push(() => resolve(route.continue())));
    return route.continue();
  });
  await context.route('**/api/documents/*/versions', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    if (gate.mode === 'hold') return new Promise((resolve) => gate.held.push(() => resolve(route.continue())));
    return route.continue();
  });
  const release = async () => { gate.held.splice(0).forEach((fn) => fn()); };
  const waitHeld = async (n) => { for (let i = 0; i < 60 && gate.held.length < n; i += 1) await new Promise((r) => setTimeout(r, 100)); };

  const page = await context.newPage();
  const consoleProblems = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleProblems.push(message.text()); });
  page.on('pageerror', (error) => consoleProblems.push(`pageerror: ${error.message}`));
  const tray = page.getByTestId('transfer-tray');
  const rows = page.getByTestId('transfer-row');
  const nav = (name) => page.getByRole('link', { name, exact: true }).first();
  const file = (name, size = 4000) => ({ name, mimeType: 'text/plain', buffer: Buffer.from('x'.repeat(size)) });
  const tipOf = async (row) => {
    await row.getByTestId('status-icon').hover();
    const box = page.getByTestId('status-tip');
    await box.waitFor({ timeout: 2000 });
    const text = await box.innerText();
    await page.mouse.move(5, 5);
    await box.waitFor({ state: 'detached', timeout: 2000 });
    return text;
  };
  const openUpload = async () => {
    await page.getByRole('button', { name: 'New' }).click();
    await page.getByRole('menuitem', { name: /Upload file/ }).click();
    const dlg = page.getByRole('dialog', { name: 'Upload file' });
    await dlg.waitFor();
    return dlg;
  };

  await page.goto(`${base}/files`);
  await page.getByRole('button', { name: 'New' }).waitFor({ timeout: 15000 });

  // ---- one click, one row, one file; the dialog closes at once ----
  gate.mode = 'hold';
  let dialog = await openUpload();
  await dialog.locator('input[type=file]').setInputFiles(file('alpha.txt'));
  await dialog.getByRole('button', { name: /Encrypt/ }).click();
  await dialog.waitFor({ state: 'detached', timeout: 4000 });
  check(true, 'the Upload dialog closes at once, while the file is still being sent');
  await tray.waitFor({ timeout: 5000 });
  await waitHeld(1);
  check((await rows.count()) === 1, 'one click: one row in the tray');
  check(/Sealing 1 file/.test(await page.getByTestId('tray-title').innerText()), 'the title says "Sealing 1 file"');
  check(gate.posts === 1, 'one request');
  check(/^(Sending this file to your vault\.|Encrypting and saving\. Almost done\.)$/.test(await tipOf(rows.first())), 'hovering a running row icon says what is happening');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'tray-sending-1280.png') });
  check(!(await tray.evaluate((el) => el.contains(document.activeElement))), 'the tray did not take the focus');

  // ---- the tray follows the person ----
  for (const [label, p] of [['Overview', '/overview'], ['Devices & activity', '/devices'], ['Trash', '/trash'], ['My files', '/files']]) {
    await nav(label).click();
    await page.waitForURL((url) => url.pathname === p, { timeout: 8000 });
    check(await tray.isVisible(), `${p}: the tray is on the page`);
  }
  await release();
  await page.getByText(/1 file sealed/).first().waitFor({ timeout: 15000 });
  check((await named(/^alpha/)).length === 1, 'the file is in the vault, once');
  await page.waitForTimeout(600);
  check((await page.getByText('alpha.txt').count()) > 1, 'the file list was refreshed by itself (the name is in the list as well as in the tray)');

  // ---- the finished tray goes away by itself ----
  await tray.waitFor({ state: 'detached', timeout: TRAY_MS + 8000 });
  check(true, `a finished tray with no failure closes by itself (set to ${TRAY_MS} ms)`);

  // ---- double click = one file ----
  gate.mode = 'pass';
  gate.posts = 0;
  dialog = await openUpload();
  await dialog.locator('input[type=file]').setInputFiles(file('beta.txt'));
  await dialog.getByRole('button', { name: /Encrypt/ }).dblclick({ delay: 10 }).catch(() => {});
  await page.waitForTimeout(1500);
  check(gate.posts === 1 && (await named(/^beta/)).length === 1, `a double click: one request, one file (${gate.posts} request(s))`);

  // ---- Cancel while the request is held ----
  await tray.waitFor({ state: 'detached', timeout: TRAY_MS + 8000 }).catch(() => {});
  gate.mode = 'hold';
  dialog = await openUpload();
  await dialog.locator('input[type=file]').setInputFiles(file('gamma.txt'));
  await dialog.getByRole('button', { name: /Encrypt/ }).click();
  await waitHeld(1);
  await tray.waitFor();
  await rows.first().getByRole('button', { name: /^Cancel/ }).click();
  await rows.first().getByText(/Canceled/).first().waitFor({ timeout: 5000 });
  check(/Canceled\. Nothing was saved\./.test(await rows.first().innerText()), 'Cancel while sending says "Canceled. Nothing was saved."');
  check((await tipOf(rows.first())) === 'Canceled. Nothing was saved.', 'and so does its tooltip');
  await release();
  await page.waitForTimeout(800);
  check((await named(/^gamma/)).length === 0, 'and nothing was saved');
  await page.getByRole('button', { name: 'Close the transfers' }).click();
  await tray.waitFor({ state: 'detached', timeout: 5000 });

  // ---- too large: refused in the dialog, which stays open ----
  gate.mode = 'pass';
  gate.posts = 0;
  dialog = await openUpload();
  await dialog.locator('input[type=file]').setInputFiles(file('huge.bin', 4 * 1024 * 1024 + 10));
  await page.waitForTimeout(500);
  check(await dialog.getByRole('button', { name: /^Encrypt/ }).isDisabled(), 'a file over 4 MB: the upload button stays off');
  check(await dialog.isVisible(), 'and the dialog stays open');
  check(/Over 4 MB/.test(await dialog.innerText()), 'with the reason on the row');
  check(gate.posts === 0 && (await tray.count()) === 0, 'nothing was sent and no row was made');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 4000 }).catch(() => {});

  // ---- a failed upload: Retry makes exactly one file ----
  gate.failNext = 1;
  gate.posts = 0;
  dialog = await openUpload();
  await dialog.locator('input[type=file]').setInputFiles(file('delta.txt'));
  await dialog.getByRole('button', { name: /Encrypt/ }).click();
  await rows.first().getByRole('button', { name: /^Retry/ }).waitFor({ timeout: 8000 });
  check(/Network error/.test(await rows.first().innerText()), 'a failed upload says "Network error"');
  check((await tipOf(rows.first())) === 'Could not finish: Network error. You can try again.', 'its tooltip says what happened and that it can be tried again');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'tray-failed-1280.png') });
  check((await named(/^delta/)).length === 0, 'nothing was saved by the failed try');
  await page.waitForTimeout(TRAY_MS + 1000);
  check(await tray.isVisible(), 'a tray with a failure stays open past the dismiss time');
  await rows.first().getByRole('button', { name: /^Retry/ }).click();
  await rows.first().getByText(/Sealed/).first().waitFor({ timeout: 10000 });
  check((await named(/^delta/)).length === 1 && gate.posts === 2, 'Retry: exactly one file');
  await page.getByRole('button', { name: 'Close the transfers' }).click();
  await tray.waitFor({ state: 'detached', timeout: 5000 });

  // ---- two files at once, a third waits ----
  gate.mode = 'hold';
  gate.posts = 0;
  const three = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    for (const n of ['one', 'two', 'three']) dt.items.add(new File([n.repeat(200)], `${n}.txt`, { type: 'text/plain' }));
    return dt;
  });
  await page.getByRole('button', { name: 'New' }).dispatchEvent('dragenter', { dataTransfer: three });
  await page.getByRole('button', { name: 'New' }).dispatchEvent('drop', { dataTransfer: three });
  await tray.waitFor();
  await waitHeld(2);
  await page.waitForTimeout(500);
  check(gate.held.length === 2 && gate.posts === 2, `two files travel at once (${gate.posts} requests), the third waits`);
  check((await rows.filter({ hasText: 'Waiting' }).count()) === 1, 'the third row says "Waiting"');
  check((await tipOf(rows.filter({ hasText: 'Waiting' }).first())) === 'Waiting its turn. Warden sends two files at a time.', 'and its tooltip explains the wait');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'tray-waiting-1280.png') });
  await release();
  await waitHeld(1);
  await release();
  await page.getByText(/3 files sealed/).first().waitFor({ timeout: 10000 });
  check((await named(/^(one|two|three)\.txt$/)).length === 3, 'all three are in the vault');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'tray-sealed-1280.png') });
  await page.getByRole('button', { name: 'Close the transfers' }).click();
  await tray.waitFor({ state: 'detached', timeout: 5000 });

  // ---- a file dropped on the page ----
  gate.mode = 'pass';
  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['dropped'.repeat(100)], 'dropped.txt', { type: 'text/plain' }));
    return dt;
  });
  await page.getByRole('button', { name: 'New' }).dispatchEvent('dragenter', { dataTransfer });
  await page.getByRole('button', { name: 'New' }).dispatchEvent('drop', { dataTransfer });
  await tray.waitFor({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);
  check((await named(/^dropped\.txt$/)).length === 1, 'a file dropped onto the Files page goes through the tray and is saved');
  await tray.waitFor({ state: 'detached', timeout: TRAY_MS + 8000 }).catch(() => {});

  // ---- Upload new version ----
  const alpha = (await named(/^alpha/))[0];
  await page.locator('button[aria-label^="Details for alpha"]').first().click();
  const panel = page.getByRole('dialog', { name: /^Details for/ });
  await panel.waitFor();
  gate.mode = 'hold';
  await panel.locator('input[type=file]').first().setInputFiles(file('alpha.txt', 5000));
  await waitHeld(1);
  await tray.waitFor();
  check((await rows.count()) >= 1, 'Upload new version makes a row in the tray');
  await release();
  await page.getByText(/1 file sealed/).first().waitFor({ timeout: 10000 });
  const details = await api('GET', `/api/documents/${alpha.id || alpha._id}/details`, { token });
  check(details.status === 200 && (details.body?.versions || []).length === 1, 'the new version was sealed (the earlier contents are kept as a version)');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Close the transfers' }).click().catch(() => {});

  // ---- the zip import is a row ----
  gate.mode = 'pass';
  const zipFile = await makeZip('backup.zip', 8);
  await nav('Export / Import').click();
  await page.waitForURL((url) => url.pathname === '/export');
  await page.locator('input[aria-label="Choose a .zip to import"]').setInputFiles(zipFile);
  await page.getByRole('button', { name: /^Import 8 files$/ }).click();
  await tray.waitFor({ timeout: 10000 });
  check(/backup\.zip/.test(await rows.first().innerText()), 'the zip import is a row of the same tray');
  await page.getByText(/8 files sealed/).first().waitFor({ timeout: 30000 });
  check((await named(/^note-/)).length === 8, 'all 8 files of the zip are in the vault');

  // ---- Escape minimizes ----
  await tray.getByRole('button', { name: 'Minimize the transfers' }).focus();
  await page.keyboard.press('Escape');
  check((await tray.getAttribute('data-minimized')) === 'true', 'Escape minimizes the tray');

  // ---- nothing in storage, no CSP problems ----
  const stored = await page.evaluate(async () => ({
    local: Object.keys(window.localStorage),
    session: Object.keys(window.sessionStorage).filter((k) => k !== 'warden.session'),
    idb: indexedDB.databases ? (await indexedDB.databases()).map((db) => db.name) : [],
    caches: (await caches.keys()).filter((key) => !key.startsWith('warden-shell')), // the app's own offline shell, never a file
  }));
  check(stored.local.length === 0 && stored.session.length === 0 && stored.idb.length === 0 && stored.caches.length === 0, `no file name was stored anywhere (${JSON.stringify(stored)})`);
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
