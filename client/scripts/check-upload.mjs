// node scripts/check-upload.mjs   (from client, after "npm run build"; DIST_DIR=<another build> to try an older one)
//
// Uploads a 4 MB PDF through the real Upload dialog in a real browser, against the real app on a LOCAL throwaway MongoDB
// (127.0.0.1:27099, or a local WARDEN_TEST_MONGO; no .env is read; mail is captured), served with the production CSP. It
// presses "Encrypt & upload" with a DOUBLE CLICK, and again with ENTER TWICE, and reports how many requests were sent and how many
// files were made, plus the client-side timing: from the press to the request leaving (the page's own work), the request itself,
// and from the press to the dialog closing. Real network, Atlas and cold-start time cannot be measured here.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

import { buildPdf } from '../src/utils/scan/pdfWriter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const dist = process.env.DIST_DIR ? path.resolve(process.env.DIST_DIR) : path.join(root, 'client', 'dist');
const requireServer = createRequire(path.join(root, 'server', 'package.json'));

const baseUri = process.env.WARDEN_TEST_MONGO || 'mongodb://127.0.0.1:27099/?replicaSet=rs0&directConnection=true';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(baseUri)) {
  console.error('WARDEN_TEST_MONGO must point at a local MongoDB. Refusing.');
  process.exit(2);
}
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('the build is missing. Run "npm run build" first.');
  process.exit(2);
}
const uri = baseUri.replace(/^(mongodb:\/\/[^/]+)\/[^?]*/, '$1/warden_upload_check');

// The production policy for the app's own pages.
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
Object.assign(process.env, { NODE_ENV: 'test', MONGO_URI: uri, SIGNUP_MODE: 'open', OTP_ENABLED: 'false', PUBLIC_APP_URL: 'https://warden.test', EMERGENCY_DEMO_MODE: 'false', STORAGE_QUOTA_MB: '200', CORS_ORIGINS: 'http://127.0.0.1:5062' });
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
await new Promise((resolve) => server.listen(5062, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:5062';

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
const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB (${(bytes / 1024 / 1024).toFixed(2)} MB)`;

async function launch() {
  const attempts = [process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}, { channel: 'chrome' }, { channel: 'msedge' }];
  let last;
  for (const options of attempts) {
    try { return await chromium.launch({ headless: true, ...options }); } catch (error) { last = error; }
  }
  throw new Error(`No Chromium found: ${String(last?.message).split('\n')[0]}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-upload-'));
let browser;
try {
  const email = 'upload.check@example.com';
  const password = 'Qx7!vTr29#mLpw';
  await api('POST', '/api/auth/signup/start', { json: { email, password, termsAccepted: true } });
  const code = /(?<![\d-])(\d{6})(?![\d-])/.exec(mails.at(-1).text)[1];
  const token = (await api('POST', '/api/auth/signup/verify', { json: { email, password, code } })).body.sessionToken;

  browser = await launch();
  const maker = await (await browser.newContext()).newPage();
  await maker.goto(`${base}/login`);
  // a page-sized noisy JPEG, then a one-page PDF of it close to the 4 MB cap
  const b64 = await maker.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 2400;
    canvas.height = 3200;
    const g = canvas.getContext('2d');
    const image = g.createImageData(2400, 3200);
    let state = 12345;
    for (let i = 0; i < image.data.length; i += 4) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const v = 120 + ((state >>> 24) % 100);
      image.data[i] = v;
      image.data[i + 1] = v - 10;
      image.data[i + 2] = v - 20;
      image.data[i + 3] = 255;
    }
    g.putImageData(image, 0, 0);
    g.fillStyle = '#222';
    g.font = '90px serif';
    for (let line = 0; line < 20; line += 1) g.fillText(`Line ${line}: the quick brown fox jumps over the lazy dog`, 120, 200 + line * 140);
    let bytes;
    for (let quality = 0.9; quality > 0.3; quality -= 0.05) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length < 3.85 * 1024 * 1024) break;
    }
    let text = '';
    for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(text);
  });
  const jpeg = Uint8Array.from(Buffer.from(b64, 'base64'));
  const pdf = buildPdf([{ jpeg, width: 2400, height: 3200 }]);
  const file = path.join(tmp, 'four-megabyte.pdf');
  fs.writeFileSync(file, pdf);
  console.log(`test file: ${kb(pdf.length)} PDF  (build: ${path.relative(root, dist)})`);

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.addInitScript((value) => {
    try { window.sessionStorage.setItem('warden.session', value); } catch { /* none */ }
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
  }, token);
  const page = await context.newPage();
  const posts = [];
  let pressedAt = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/documents') posts.push({ start: Date.now(), request });
  });
  page.on('requestfinished', (request) => {
    const post = posts.find((entry) => entry.request === request);
    if (post) post.end = Date.now();
  });
  await page.goto(`${base}/files`);
  await page.getByRole('button', { name: 'New' }).waitFor({ timeout: 15000 });

  const countDocs = async () => (await api('GET', '/api/documents', { token })).body.filter((doc) => /^four-megabyte/.test(doc.filename));
  const presses = [
    ['double click', async (button) => { pressedAt = Date.now(); await button.dblclick({ delay: 10 }); }],
    ['Enter twice', async (button) => { await button.focus(); pressedAt = Date.now(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); }],
  ];
  for (const [label, press] of presses) {
    posts.length = 0;
    const before = (await countDocs()).length;
    await page.getByRole('button', { name: 'New' }).click();
    await page.getByRole('menuitem', { name: /Upload file/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Upload file' });
    await dialog.waitFor();
    await dialog.locator('input[type=file]').setInputFiles(file);
    await press(dialog.getByRole('button', { name: /Encrypt/ }));
    const labelAfter = await dialog.getByRole('button', { name: /Encrypt|Encrypting/ }).last().innerText({ timeout: 2000 }).catch(() => '(already closed)');
    await dialog.waitFor({ state: 'detached', timeout: 90000 }).catch(() => {});
    const closedAt = Date.now();
    await page.waitForTimeout(800);
    const docs = await countDocs();
    const made = docs.length - before;
    const first = posts[0];
    console.log(`\n${label}: ${posts.length} request(s) sent, ${made} file(s) made (${docs.map((doc) => doc.filename).join(', ')})`);
    if (first?.end) console.log(`  the page's own work before the request left: ${first.start - pressedAt} ms;  the request (send, server, answer): ${first.end - first.start} ms;  press to dialog closed: ${closedAt - pressedAt} ms;  button right after the press: "${labelAfter.replace(/\s+/g, ' ')}"`);
    check(posts.length === 1, `${label}: exactly one request`);
    check(made === 1, `${label}: exactly one file`);
  }
  const csp = await page.evaluate(() => window.__csp);
  check(csp.length === 0, `no CSP violations (${csp.join('; ') || 'none'})`);
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
