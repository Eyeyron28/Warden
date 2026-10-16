// node scripts/check-multiupload.mjs   (from client, after "npm run build"; DIST_DIR=<another build> to try another one)
//
// The Upload dialog with several files, in a real browser against the real app on a LOCAL throwaway MongoDB (127.0.0.1:27099, or a
// local WARDEN_TEST_MONGO; no .env is read), served with the production CSP. Files are made in memory. It checks: 12 selected files
// give 10 rows and "2 were not added"; a removed row can be replaced with "Choose more"; an over-4 MB file shows its error and is
// skipped; 3 valid files close the dialog at once, show 3 tray rows (2 running, 1 waiting) and all arrive in Files; files dropped
// on the zone are added; no CSP violations.
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

const baseUri = process.env.WARDEN_TEST_MONGO || 'mongodb://127.0.0.1:27099/?replicaSet=rs0&directConnection=true';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(baseUri)) {
  console.error('WARDEN_TEST_MONGO must point at a local MongoDB. Refusing.');
  process.exit(2);
}
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('the build is missing. Run "npm run build" first.');
  process.exit(2);
}
const uri = baseUri.replace(/^(mongodb:\/\/[^/]+)\/[^?]*/, '$1/warden_multiupload_check');

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
Object.assign(process.env, { NODE_ENV: 'test', MONGO_URI: uri, SIGNUP_MODE: 'open', OTP_ENABLED: 'false', PUBLIC_APP_URL: 'https://warden.test', EMERGENCY_DEMO_MODE: 'false', STORAGE_QUOTA_MB: '200', CORS_ORIGINS: 'http://127.0.0.1:5067' });
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
await new Promise((resolve) => server.listen(5067, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:5067';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-multiupload-'));

const file = (name, size = 3000) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(`${name} `.repeat(Math.ceil(size / (name.length + 1))).slice(0, size)) });

let browser;
try {
  const email = 'multiupload.check@example.com';
  const password = 'Qx7!vTr29#mLpw';
  await api('POST', '/api/auth/signup/start', { json: { email, password, termsAccepted: true } });
  const code = /(?<![\d-])(\d{6})(?![\d-])/.exec(mails.at(-1).text)[1];
  const token = (await api('POST', '/api/auth/signup/verify', { json: { email, password, code } })).body.sessionToken;
  const docs = async () => (await api('GET', '/api/documents', { token })).body;

  browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  await context.addInitScript((value) => {
    try { window.sessionStorage.setItem('warden.session', value); } catch { /* none */ }
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
  }, token);
  // the script holds uploads back, so the tray's running and waiting rows can be looked at
  const gate = { hold: false, held: [], posts: 0 };
  await context.route('**/api/documents', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    gate.posts += 1;
    if (gate.hold) return new Promise((resolve) => gate.held.push(() => resolve(route.continue())));
    return route.continue();
  });
  const page = await context.newPage();
  const consoleProblems = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleProblems.push(message.text()); });
  page.on('pageerror', (error) => consoleProblems.push(`pageerror: ${error.message}`));
  const tray = page.getByTestId('transfer-tray');
  const trayRows = page.getByTestId('transfer-row');
  const openDialog = async () => {
    await page.getByRole('button', { name: 'New' }).click();
    await page.getByRole('menuitem', { name: /Upload file/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Upload file' });
    await dialog.waitFor();
    return dialog;
  };

  await page.goto(`${base}/files`);
  await page.getByRole('button', { name: 'New' }).waitFor({ timeout: 15000 });

  // ---- 12 files: ten rows and a visible message ----
  let dialog = await openDialog();
  const rows = dialog.getByTestId('upload-row');
  const input = dialog.locator('input[type=file]');
  check((await input.getAttribute('multiple')) !== null, 'the file input accepts several files');
  check((await dialog.getByRole('button', { name: 'Choose files' }).count()) === 1 && /or drop them here/.test(await dialog.innerText()), 'the zone says "Choose files" and "or drop them here"');
  check(/Expiry date for all files \(optional\)/.test(await dialog.innerText()), 'the expiry label says it applies to all files');
  check(await dialog.getByRole('button', { name: /^Encrypt & upload/ }).isDisabled(), 'the upload button is off with no files');
  await input.setInputFiles(Array.from({ length: 12 }, (_, n) => file(`batch-${String(n + 1).padStart(2, '0')}.txt`)));
  await rows.first().waitFor();
  check((await rows.count()) === 10, '12 selected files give 10 rows');
  check(/2 were not added/.test(await dialog.getByTestId('upload-limit-message').innerText()), 'the message says "Only 10 files at a time. 2 were not added."');
  check(/10 of 10 files/.test(await dialog.getByTestId('upload-counter').innerText()), 'the counter reads "10 of 10 files · …"');
  check((await dialog.getByRole('button', { name: 'Encrypt & upload 10 files' }).count()) === 1, 'the button reads "Encrypt & upload 10 files"');
  const box = await dialog.boundingBox();
  check(box.y >= 0 && box.y + box.height <= 860 && box.height <= 860 * 0.9, `the dialog stays within 90 vh and the screen (${Math.round(box.height)} px high at 860)`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'multiupload-10-files-1280.png') });

  // ---- remove one, choose more ----
  await rows.first().getByRole('button', { name: /^Remove batch-01/ }).click();
  check((await rows.count()) === 9, 'a removed row is gone');
  await input.setInputFiles([file('replacement.txt')]);
  await page.waitForTimeout(200);
  check((await rows.count()) === 10 && (await dialog.getByText('replacement.txt').count()) >= 1, '"Choose more" adds another file in its place');
  // keyboard: Delete on a focused row
  await rows.nth(2).focus();
  await page.keyboard.press('Delete');
  check((await rows.count()) === 9, 'Delete on a focused row removes it');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'detached' });

  // ---- an over-size file is skipped, 3 valid files go to the tray ----
  dialog = await openDialog();
  await dialog.locator('input[type=file]').setInputFiles([file('one.txt'), file('big.bin', 4 * 1024 * 1024 + 10), file('two.txt'), file('three.txt'), file('empty.txt', 0)]);
  await dialog.getByTestId('upload-row').first().waitFor();
  const errorRows = dialog.locator('[data-testid="upload-row"][data-error="true"]');
  check((await errorRows.count()) === 2, 'the over-size and the empty file keep their rows with an error');
  check(/Over 4 MB/.test(await errorRows.first().innerText()) && /Empty file/.test(await errorRows.nth(1).innerText()), 'the reasons are "Over 4 MB" and "Empty file"');
  const submit = dialog.getByRole('button', { name: 'Encrypt & upload 3 files' });
  check((await submit.count()) === 1 && (await submit.isEnabled()), 'the button counts only the 3 valid files');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'multiupload-error-rows-1280.png') });
  gate.hold = true;
  gate.posts = 0;
  await submit.click();
  await dialog.waitFor({ state: 'detached', timeout: 4000 });
  check(true, 'the dialog closes at once');
  await tray.waitFor({ timeout: 5000 });
  for (let i = 0; i < 40 && gate.held.length < 2; i += 1) await page.waitForTimeout(100);
  await page.waitForTimeout(400);
  check((await trayRows.count()) === 3, 'the tray shows 3 rows (the skipped files are not in it)');
  check(gate.held.length === 2 && (await trayRows.filter({ hasText: 'Waiting' }).count()) === 1, '2 are running and 1 is waiting');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'multiupload-tray-1280.png') });
  gate.hold = false;
  gate.held.splice(0).forEach((fn) => fn());
  await page.getByText(/3 files sealed/).first().waitFor({ timeout: 15000 });
  const names = (await docs()).map((d) => d.filename).sort();
  check(JSON.stringify(names) === JSON.stringify(['one.txt', 'three.txt', 'two.txt']), `exactly the 3 valid files are in the vault (${names.join(', ')})`);
  await page.waitForTimeout(600);
  check((await page.getByRole('button', { name: 'one.txt' }).count()) + (await page.getByText('three.txt').count()) >= 1, 'and they show in Files');
  await tray.getByRole('button', { name: 'Close the transfers' }).click();

  // ---- drop onto the zone ----
  dialog = await openDialog();
  const zone = dialog.getByTestId('upload-zone');
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File(['dropped one'], 'dropped-1.txt', { type: 'text/plain' }));
    d.items.add(new File(['dropped two'], 'dropped-2.txt', { type: 'text/plain' }));
    return d;
  });
  await zone.dispatchEvent('dragenter', { dataTransfer: dt });
  check((await zone.getAttribute('data-over')) === 'true', 'the zone highlights on drag over');
  await zone.dispatchEvent('drop', { dataTransfer: dt });
  await dialog.getByTestId('upload-row').first().waitFor({ timeout: 3000 });
  check((await dialog.getByTestId('upload-row').count()) === 2 && (await zone.getAttribute('data-over')) === null, 'dropped files are added as rows and the highlight goes');
  await dialog.getByRole('button', { name: 'Encrypt & upload 2 files' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 4000 });
  for (let i = 0; i < 40 && (await docs()).length < 5; i += 1) await page.waitForTimeout(250);
  check((await docs()).length === 5, `the two dropped files were uploaded too (${(await docs()).map((d) => d.filename).join(', ')})`);

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
