import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import JSZip from 'jszip';
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
const uri = baseUri.replace(/^(mongodb:\/\/[^/]+)\/[^?]*/, '$1/warden_limits_check');

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
Object.assign(process.env, { NODE_ENV: 'test', MONGO_URI: uri, SIGNUP_MODE: 'open', OTP_ENABLED: 'false', PUBLIC_APP_URL: 'https://warden.test', EMERGENCY_DEMO_MODE: 'false', STORAGE_QUOTA_MB: '200', CORS_ORIGINS: 'http://127.0.0.1:5068' });
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
await new Promise((resolve) => server.listen(5068, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:5068';

async function api(method, route, { token, json, keep = false } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  let body;
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  if (!keep) await mongoose.models.RateLimit.deleteMany({});
  const response = await fetch(base + route, { method, headers, body });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {  }
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


const file = (name, size = 400) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(`${name} `.repeat(Math.ceil(size / (name.length + 1))).slice(0, size)) });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-limits-'));

let browser;
try {
  const email = 'limits.check@example.com';
  const password = 'Qx7!vTr29#mLpw';
  await api('POST', '/api/auth/signup/start', { json: { email, password, termsAccepted: true } });
  const code = /(?<![\d-])(\d{6})(?![\d-])/.exec(mails.at(-1).text)[1];
  const token = (await api('POST', '/api/auth/signup/verify', { json: { email, password, code } })).body.sessionToken;
  const docs = async () => (await api('GET', '/api/documents', { token, keep: true })).body;
  const clearCounters = () => mongoose.models.RateLimit.deleteMany({});

  browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  await context.addInitScript((value) => {
    try { window.sessionStorage.setItem('warden.session', value); } catch {  }
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
  }, token);
  const posts = { n: 0, statuses: [] };
  await context.route('**/api/documents', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts.n += 1;
    return route.continue();
  });
  const page = await context.newPage();
  page.on('response', (response) => {
    if (response.request().method() === 'POST' && /\/api\/documents$/.test(response.url())) posts.statuses.push(response.status());
  });
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

  process.env.UPLOAD_MINUTE_LIMIT = '3';
  await clearCounters();
  let dialog = await openDialog();
  await dialog.locator('input[type=file]').setInputFiles(Array.from({ length: 8 }, (_, n) => file(`speed-${n + 1}.txt`)).slice(0, 8));
  await dialog.getByTestId('upload-row').first().waitFor();
  posts.n = 0;
  posts.statuses.length = 0;
  await dialog.getByRole('button', { name: /^Encrypt & upload 8 files/ }).click();
  await dialog.waitFor({ state: 'detached', timeout: 4000 });
  await tray.waitFor({ timeout: 5000 });
  const notSaved = trayRows.filter({ hasText: 'Not saved' });
  for (let i = 0; i < 60 && (await notSaved.count()) < 5; i += 1) await page.waitForTimeout(150);
  await page.waitForTimeout(500);
  check((await notSaved.count()) === 5, `5 rows say "Not saved" (${await notSaved.count()})`);
  check((await trayRows.filter({ hasText: 'Sealed' }).count()) === 3, '3 rows are sealed (the limit is 3 a minute)');
  const firstText = await notSaved.first().innerText();
  check(/Too many uploads at once\. Try again in 1 minute\./.test(firstText), `the row says "Too many uploads at once. Try again in 1 minute." (${firstText.replace(/\s+/g, ' ').slice(0, 90)})`);
  check((await notSaved.first().getByRole('button', { name: /^Retry/ }).count()) === 1, 'each Not saved row has a Retry button');
  check(posts.n < 8, `the queued files were marked without sending them: ${posts.n} requests for 8 files (${posts.statuses.join(',')})`);
  check(posts.statuses.filter((s) => s === 429).length >= 1 && posts.statuses.filter((s) => s === 201).length === 3, 'the server answered 201 three times and 429 for the rest');
  await notSaved.first().getByTestId('status-icon').hover();
  await page.getByTestId('tooltip').waitFor({ timeout: 2500 });
  check(/^Not saved: Too many uploads at once\. Try again in 1 minute\.$/.test((await page.getByTestId('tooltip').innerText()).trim()), 'the status icon tooltip says the same');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'limits-tray-1280.png') });
  const before = posts.n;
  await page.waitForTimeout(1500);
  check(posts.n === before, 'nothing is sent again by itself');
  await notSaved.first().getByRole('button', { name: /^Retry/ }).click();
  await page.waitForTimeout(800);
  check(posts.n === before + 1 && (await notSaved.count()) === 5, 'Retry inside the same minute asks once and is refused again');
  await clearCounters();
  await notSaved.first().getByRole('button', { name: /^Retry/ }).click();
  for (let i = 0; i < 60 && (await trayRows.filter({ hasText: 'Sealed' }).count()) < 4; i += 1) await page.waitForTimeout(150);
  check((await notSaved.count()) === 4 && (await trayRows.filter({ hasText: 'Sealed' }).count()) === 4, 'Retry after the limit is over seals that file');
  check((await docs()).length === 4, `4 files are in the vault (${(await docs()).length})`);
  await tray.getByRole('button', { name: 'Close the transfers' }).click().catch(() => {});
  delete process.env.UPLOAD_MINUTE_LIMIT;

  const have = (await docs()).length;
  process.env.MAX_DOCUMENTS_PER_ACCOUNT = String(have + 5);
  const zip = new JSZip();
  for (let i = 1; i <= 12; i += 1) zip.file(`Backup/note-${String(i).padStart(2, '0')}.txt`, `note number ${i} `.repeat(30));
  const zipPath = path.join(tmp, 'many.zip');
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: 'uint8array' }));
  await clearCounters();
  await page.goto(`${base}/export`);
  await page.locator('input[aria-label="Choose a .zip to import"]').setInputFiles(zipPath);
  await page.getByRole('button', { name: /^Import 12 files$/ }).click();
  const report = page.getByTestId('import-report');
  await report.waitFor({ timeout: 20000 });
  const reportText = (await report.innerText()).replace(/\s+/g, ' ');
  const cap = have + 5;
  check(new RegExp(`Stopped: You have reached the limit of ${cap} files\\. Delete some files or empty the Trash\\. [56] files were imported`).test(reportText), `the report says it stopped and how many were imported (${reportText.slice(0, 200)})`);
  check(/not imported/.test(reportText) || (await report.getByText(/Not imported/).count()) >= 1, 'and lists the files that were not imported');
  const after = await docs();
  check(after.length >= cap && after.length <= cap + 1, `what was imported is kept: ${after.length} files in the vault for a cap of ${cap}`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'limits-import-stopped-1280.png') });

  await clearCounters();
  await page.goto(`${base}/files`);
  await page.getByRole('button', { name: 'New' }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
  const postsBefore = posts.n;
  dialog = await openDialog();
  await dialog.locator('input[type=file]').setInputFiles([file('one-too-many.txt')]);
  await dialog.getByTestId('upload-row').first().waitFor();
  await page.waitForTimeout(500);
  const dialogText = (await dialog.innerText()).replace(/\s+/g, ' ');
  check(/limit of \d+ files|You can add 0 more|reached the limit/.test(dialogText) || /Delete some files or empty the Trash/.test(dialogText), `the dialog says the limit is reached before sending (${dialogText.slice(-160)})`);
  check(await dialog.getByRole('button', { name: /^Encrypt/ }).evaluate((el) => el.disabled || el.getAttribute('aria-disabled') === 'true'), 'and the upload button is off');
  check(posts.n === postsBefore, 'with no request sent');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'limits-dialog-1280.png') });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  delete process.env.MAX_DOCUMENTS_PER_ACCOUNT;

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
