// node scripts/check-quarantine.mjs   (from client, after "npm run build"; DIST_DIR=<another build> to try another one)
//
// Quarantine in a real browser against the real app on a LOCAL throwaway MongoDB (127.0.0.1:27099, or a local WARDEN_TEST_MONGO; no
// .env is read; mail is captured), served with the production CSP. The sample files are built in memory when the script runs (nothing
// is committed, nothing is written to disk, and the antivirus test string is joined from parts). It checks that: a risky sample is held
// ("Held for review"), is missing from Files and Recent, shows in Quarantine with its reasons and cannot be previewed or downloaded;
// Release does nothing with the wrong word and brings the file into Files with the right one; a blocked sample shows "Not saved" and is
// stored nowhere; a clean file is unaffected and the scan does not slow an upload down; no CSP violations.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

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
const uri = baseUri.replace(/^(mongodb:\/\/[^/]+)\/[^?]*/, '$1/warden_quarantine_check');

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
Object.assign(process.env, { NODE_ENV: 'test', MONGO_URI: uri, SIGNUP_MODE: 'open', OTP_ENABLED: 'false', PUBLIC_APP_URL: 'https://warden.test', EMERGENCY_DEMO_MODE: 'false', STORAGE_QUOTA_MB: '200', CORS_ORIGINS: 'http://127.0.0.1:5066' });
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
await new Promise((resolve) => server.listen(5066, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:5066';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-quarantine-'));

// ---- the samples: built here, in memory ----
const pdfWith = (marker) => Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R ${marker} >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`);
const riskyPdf = () => pdfWith('/JavaScript');
const testSignature = () => Buffer.from(['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-', 'ANTIVIRUS-TEST-FILE!', '$H+H*'].join(''));
const sample = (name, buffer, mimeType = 'application/octet-stream') => ({ name, mimeType, buffer });

async function postFile(token, name, buffer) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/octet-stream' }), name);
  const started = performance.now();
  const response = await fetch(`${base}/api/documents`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  await response.text();
  return { status: response.status, ms: performance.now() - started };
}

let browser;
try {
  const email = 'quarantine.check@example.com';
  const password = 'Qx7!vTr29#mLpw';
  await api('POST', '/api/auth/signup/start', { json: { email, password, termsAccepted: true } });
  const code = /(?<![\d-])(\d{6})(?![\d-])/.exec(mails.at(-1).text)[1];
  const token = (await api('POST', '/api/auth/signup/verify', { json: { email, password, code } })).body.sessionToken;
  const docs = async () => (await api('GET', '/api/documents', { token })).body;
  const heldList = async () => (await api('GET', '/api/quarantine', { token })).body;
  const countAll = () => mongoose.models.Document.countDocuments({});

  browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  await context.addInitScript(([value, ms]) => {
    try { window.sessionStorage.setItem('warden.session', value); } catch { /* none */ }
    window.__WARDEN_TEST__ = { importCardMs: ms };
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
  }, [token, TRAY_MS]);
  const page = await context.newPage();
  const consoleProblems = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleProblems.push(message.text()); });
  page.on('pageerror', (error) => consoleProblems.push(`pageerror: ${error.message}`));
  const tray = page.getByTestId('transfer-tray');
  const rows = page.getByTestId('transfer-row');
  const nav = (name) => page.getByRole('link', { name, exact: true }).first();
  const uploadVia = async (file) => {
    await page.getByRole('button', { name: 'New' }).click();
    await page.getByRole('menuitem', { name: /Upload file/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Upload file' });
    await dialog.waitFor();
    await dialog.locator('input[type=file]').setInputFiles(file);
    await dialog.getByRole('button', { name: /Encrypt/ }).click();
    await dialog.waitFor({ state: 'detached', timeout: 5000 });
  };
  const closeTray = async () => {
    if (await tray.count()) {
      await tray.getByRole('button', { name: 'Close the transfers' }).click().catch(() => {});
      await tray.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    }
  };

  await page.goto(`${base}/files`);
  await page.getByRole('button', { name: 'New' }).waitFor({ timeout: 15000 });

  // ---- a clean file is unaffected ----
  await uploadVia(sample('clean-note.txt', Buffer.from('an ordinary note')));
  await rows.first().getByText(/^Sealed$/).waitFor({ timeout: 10000 });
  check(/1 file sealed/.test(await page.getByTestId('tray-title').innerText()), 'a clean file is sealed as before ("1 file sealed")');
  check((await docs()).some((d) => d.filename === 'clean-note.txt'), 'and it is in the vault');
  check((await heldList()).count === 0, 'nothing is held');
  await closeTray();

  // ---- a risky file is held ----
  await uploadVia(sample('tax-form.pdf', riskyPdf(), 'application/pdf'));
  await rows.first().getByText(/Held for review/).waitFor({ timeout: 10000 });
  check(/Held for review: PDF with active content/.test(await rows.first().innerText()), 'the tray row says "Held for review: PDF with active content"');
  check((await rows.first().getAttribute('data-ring')) === 'held', 'with the amber held ring');
  check(/held for review/.test(await page.getByTestId('tray-title').innerText()), 'the tray title says so');
  check((await rows.first().getByRole('button', { name: /^Open Quarantine/ }).count()) === 1, 'and offers a way to Quarantine');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'quarantine-tray-held-1280.png') });
  await page.waitForTimeout(TRAY_MS + 1000);
  check(await tray.isVisible(), 'a held file keeps the tray open (it needs a decision)');
  const badge = page.getByTestId('quarantine-badge');
  await page.waitForTimeout(300);
  check((await badge.count()) === 1 && (await badge.innerText()).trim() === '1', 'the sidebar item shows a badge with 1');
  if (SHOTS) {
    // the badge in the icon rail and in the phone drawer
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await page.waitForTimeout(300);
    check((await page.getByTestId('quarantine-badge').count()) === 1, 'the badge is also on the icon in the collapsed sidebar');
    await page.screenshot({ path: path.join(SHOTS, 'quarantine-sidebar-collapsed-1280.png') });
    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await page.setViewportSize({ width: 360, height: 800 });
    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    await page.waitForTimeout(400);
    check((await page.getByTestId('quarantine-badge').count()) === 1, 'and in the phone drawer');
    await page.screenshot({ path: path.join(SHOTS, 'quarantine-sidebar-drawer-360.png') });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1280, height: 860 });
  }
  check(!(await page.getByText('tax-form.pdf', { exact: false }).filter({ hasNot: tray }).count()) || (await page.locator('main').getByText('tax-form.pdf').count()) === 0, 'it is not in the Files list');
  check(!(await docs()).some((d) => d.filename === 'tax-form.pdf'), 'the file list from the server leaves it out');
  await closeTray();

  // Recent: the held file is not there
  await nav('Recent').click();
  await page.waitForURL((url) => url.pathname === '/recent');
  await page.waitForTimeout(800);
  check((await page.getByText('tax-form.pdf').count()) === 0, 'it is not in Recent');
  await nav('Photos').click();
  await page.waitForURL((url) => url.pathname === '/photos');
  check((await page.getByText('tax-form.pdf').count()) === 0, 'it is not in Photos');

  // ---- Quarantine page ----
  await page.getByRole('link', { name: /^Quarantine/ }).first().click();
  await page.waitForURL((url) => url.pathname === '/quarantine');
  const heldRows = page.getByTestId('quarantine-row');
  await heldRows.first().waitFor({ timeout: 8000 });
  check((await page.getByRole('heading', { name: 'Quarantine', level: 1 }).count()) === 1, 'the page is called Quarantine');
  check(/not a full antivirus/.test(await page.locator('main').innerText()), 'it says honestly that this is not a full antivirus');
  const rowText = await heldRows.first().innerText();
  check((await heldRows.first().locator('[title="tax-form.pdf"]').count()) === 1 && /active content/.test(rowText) && /Medium/.test(rowText), 'the row shows the name, a severity chip and the reason in plain words');
  check((await page.getByTestId('quarantine-badge').innerText()).trim() === '1', 'the badge still says 1');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'quarantine-page-1280.png') });

  // preview and download are impossible
  const held1 = (await heldList()).items[0];
  const viewResponse = await fetch(`${base}/api/documents/${held1.id}/view`, { headers: { authorization: `Bearer ${token}` } });
  const viewBody = await viewResponse.text();
  check(viewResponse.status === 409 && /QUARANTINED/.test(viewBody) && !/JavaScript/.test(viewBody), 'preview / download answer 409 QUARANTINED and send no content');
  const shareResponse = await api('POST', `/api/documents/${held1.id}/share`, { token, json: { durationHours: 24 } });
  check(shareResponse.status === 409, 'a share link cannot be made for it');

  // ---- Release: the wrong word does nothing, the right word brings it back ----
  await heldRows.first().getByRole('button', { name: /^Release/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Release this file?' });
  await dialog.waitFor();
  const confirm = dialog.getByRole('button', { name: 'Release file' });
  check(await confirm.isDisabled(), 'the Release button is off until the word is typed');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'quarantine-release-dialog-1280.png') });
  await dialog.getByLabel(/Type RELEASE/).fill('release');
  check(await confirm.isDisabled(), 'the wrong word ("release") keeps it off');
  await confirm.click({ force: true }).catch(() => {});
  await page.waitForTimeout(500);
  check((await heldList()).count === 1, 'nothing was released with the wrong word');
  await dialog.getByLabel(/Type RELEASE/).fill('RELEASE');
  check(await confirm.isEnabled(), 'the right word turns the button on');
  await confirm.click();
  await dialog.waitFor({ state: 'detached', timeout: 6000 });
  await page.getByTestId('quarantine-empty').waitFor({ timeout: 6000 });
  check((await heldList()).count === 0, 'the file left Quarantine');
  check((await page.getByTestId('quarantine-badge').count()) === 0, 'the badge is gone');
  check((await docs()).some((d) => d.filename === 'tax-form.pdf'), 'the file is now in the file list');
  check((await fetch(`${base}/api/documents/${held1.id}/view`, { headers: { authorization: `Bearer ${token}` } })).status === 200, 'and it can be opened');
  await nav('My files').click();
  await page.waitForURL((url) => url.pathname === '/files');
  await page.getByText('tax-form.pdf').first().waitFor({ timeout: 8000 });
  check(true, 'it shows in My files');
  // Details: "Released after review"
  await page.locator('button[aria-label^="Details for tax-form"]').first().click();
  const panel = page.getByRole('dialog', { name: /^Details for/ });
  await panel.waitFor();
  await panel.getByText('Scan', { exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
  check(/Released after review/.test(await panel.innerText()), 'Details says "Released after review"');
  await page.keyboard.press('Escape');

  // ---- a blocked file shows "Not saved" and is stored nowhere ----
  const before = await countAll();
  await uploadVia(sample('notes.txt', testSignature()));
  await rows.first().getByText(/Not saved/).waitFor({ timeout: 10000 });
  check(/Not saved: antivirus test file/.test(await rows.first().innerText()), 'the tray row says "Not saved: antivirus test file"');
  check((await rows.first().getAttribute('data-ring')) === 'refused', 'with the red ring');
  check((await rows.first().getByRole('button', { name: /^Retry/ }).count()) === 0, 'and no Retry');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'quarantine-tray-refused-1280.png') });
  check((await countAll()) === before, 'nothing was stored');
  check(!(await docs()).some((d) => d.filename === 'notes.txt') && (await heldList()).count === 0, 'it is in no list and not in Quarantine');
  await closeTray();

  // ---- the scan does not slow an upload down ----
  const scanner = requireServer('./utils/fileScanner');
  const real = scanner.scanBuffer;
  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(3.5 * 1024 * 1024, 0x41), Buffer.from('\n%%EOF')]);
  const timesReal = [];
  const timesOff = [];
  for (let n = 0; n < 10; n += 1) {
    scanner.scanBuffer = real;
    timesReal.push((await postFile(token, `speed-a-${n}.pdf`, big)).ms);
    scanner.scanBuffer = () => ({ verdict: 'clean', reasons: [], score: 0, version: 1 }); // the scan switched off, for the comparison only
    timesOff.push((await postFile(token, `speed-b-${n}.pdf`, big)).ms);
  }
  scanner.scanBuffer = real;
  const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
  const scanMs = (() => { const t = process.hrtime.bigint(); real({ name: 'x.pdf', type: '', buffer: big }); return Number(process.hrtime.bigint() - t) / 1e6; })();
  console.log(`upload of 3.5 MB (median of 10): with the scan ${median(timesReal).toFixed(0)} ms, scan switched off ${median(timesOff).toFixed(0)} ms; the scan alone ${scanMs.toFixed(1)} ms`);
  check(median(timesReal) - median(timesOff) < 50, `the scan adds under 50 ms to a 3.5 MB upload (${(median(timesReal) - median(timesOff)).toFixed(1)} ms)`);

  // ---- nothing stored in the browser, no CSP problems ----
  const stored = await page.evaluate(async () => ({
    local: Object.keys(window.localStorage),
    idb: indexedDB.databases ? (await indexedDB.databases()).map((db) => db.name) : [],
    caches: (await caches.keys()).filter((key) => !key.startsWith('warden-shell')),
  }));
  check(stored.local.length === 0 && stored.idb.length === 0 && stored.caches.length === 0, `nothing about held files was stored in the browser (${JSON.stringify(stored)})`);
  const csp = await page.evaluate(() => window.__csp).catch(() => []);
  check(csp.length === 0, `no CSP violations (${csp.join('; ') || 'none'})`);
  const bad = consoleProblems.filter((line) => /content security policy|refused to|violat/i.test(line));
  check(bad.length === 0, `no CSP errors in the console${bad.length ? `: ${bad.join(' | ')}` : ''}`);
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
