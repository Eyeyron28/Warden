// node scripts/check-scan.mjs   (from client, after "npm run build")
//
// Drives the Scan dialog in a real browser against the real app on a LOCAL throwaway MongoDB (127.0.0.1:27099, or a local
// WARDEN_TEST_MONGO; anything else is refused; no .env is read; mail is captured). The app is served WITH the production
// Content-Security-Policy from vercel.json, so a violation shows up. It scans two sample photos (one with an EXIF orientation),
// rotates, crops (mouse drag and keyboard), switches Document mode, saves a PDF, and checks the file in the list, in the preview,
// under the cap, and that the scanner left nothing in browser storage. Then a second scan saves separate JPEGs, a third pushes
// ten full-size noisy photos at the cap, and the sizes for a 12 MP photo are printed.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const dist = path.join(root, 'client', 'dist');
const requireServer = createRequire(path.join(root, 'server', 'package.json'));
const SHOTS = process.env.SHOTS || '';

const baseUri = process.env.WARDEN_TEST_MONGO || 'mongodb://127.0.0.1:27099/?replicaSet=rs0&directConnection=true';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(baseUri)) {
  console.error('WARDEN_TEST_MONGO must point at a local MongoDB. Refusing.');
  process.exit(2);
}
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('client/dist is missing. Run "npm run build" first.');
  process.exit(2);
}
const uri = baseUri.replace(/^(mongodb:\/\/[^/]+)\/[^?]*/, '$1/warden_scan_check');

// The production policy for the app's own pages.
const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const CSP = JSON.stringify(vercel)
  .match(/"Content-Security-Policy","value":"(default-src 'self'[^"]+)"/)?.[1]
  // vercel.json is served over https; the local rig is http, so the upgrade directive would break every request
  .replace('; upgrade-insecure-requests', '');
if (!CSP) throw new Error('could not find the app Content-Security-Policy in vercel.json');

const load = Module._load;
Module._load = function stubbed(request, ...rest) {
  return request === 'dotenv' ? { config: () => ({}), parse: () => ({}) } : load.call(this, request, ...rest);
};
for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM', 'VERCEL', 'INVITE_CODE', 'CRON_SECRET']) delete process.env[name];
Object.assign(process.env, { NODE_ENV: 'test', MONGO_URI: uri, SIGNUP_MODE: 'open', OTP_ENABLED: 'false', PUBLIC_APP_URL: 'https://warden.test', EMERGENCY_DEMO_MODE: 'false', STORAGE_QUOTA_MB: '200', CORS_ORIGINS: 'http://127.0.0.1:5058' });
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
await new Promise((resolve) => server.listen(5058, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function api(method, route, { token, json } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  let body;
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  await mongoose.models.RateLimit.deleteMany({});
  const response = await fetch(base + route, { method, headers, body });
  const buffer = Buffer.from(await response.arrayBuffer());
  let parsed = null;
  try { parsed = JSON.parse(buffer.toString('utf8')); } catch { /* binary */ }
  return { status: response.status, body: parsed, buffer };
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

/** A sample "photo": lit paper with lines of text and grain, as a JPEG (base64), drawn in the browser. */
async function makePhoto(page, { width, height, seed, grain = 10, quality = 0.92 }) {
  return page.evaluate(async ({ width, height, seed, grain, quality }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    const light = g.createLinearGradient(0, 0, width, height);
    light.addColorStop(0, '#5a5650');
    light.addColorStop(1, '#8c867a');
    g.fillStyle = light;
    g.fillRect(0, 0, width, height);
    g.save();
    g.translate(width / 2, height / 2);
    g.rotate(((seed % 5) - 2) * 0.01);
    g.fillStyle = '#d8d2c4';
    g.fillRect(-width * 0.4, -height * 0.42, width * 0.8, height * 0.84);
    g.fillStyle = '#2a2824';
    g.font = `${Math.round(height / 28)}px serif`;
    for (let line = 0; line < 22; line += 1) g.fillText(`Page ${seed}  Line ${line + 1}: the quick brown fox jumps over the lazy dog 0123456789`, -width * 0.36, -height * 0.36 + line * (height / 30));
    g.restore();
    const image = g.getImageData(0, 0, width, height);
    let state = seed * 2654435761 >>> 0;
    for (let i = 0; i < image.data.length; i += 4) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const n = ((state >>> 24) / 255 - 0.5) * 2 * grain;
      image.data[i] += n;
      image.data[i + 1] += n;
      image.data[i + 2] += n;
    }
    g.putImageData(image, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(text);
  }, { width, height, seed, grain, quality });
}

/** Adds an EXIF "Orientation" tag to a JPEG (what a phone does when it is held sideways). */
function withOrientation(jpeg, orientation) {
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(exif.length + 2);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), length, exif, jpeg.subarray(2)]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-scan-'));
const write = (name, buffer) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, buffer);
  return file;
};

let browser;
try {
  // ---- the account ----
  const email = 'scan.check@example.com';
  const password = 'Qx7!vTr29#mLpw';
  await api('POST', '/api/auth/signup/start', { json: { email, password, termsAccepted: true } });
  const code = /(?<![\d-])(\d{6})(?![\d-])/.exec(mails.at(-1).text)[1];
  const token = (await api('POST', '/api/auth/signup/verify', { json: { email, password, code } })).body.sessionToken;
  await api('POST', '/api/documents/folders', { token, json: { name: 'Papers', parentPath: '' } });

  browser = await launch();
  const maker = await (await browser.newContext()).newPage();
  await maker.goto(`${base}/login`);
  const photo = (b64) => Buffer.from(b64, 'base64');
  // a 12-megapixel photo (4032 x 3024) of the kind a phone makes, and smaller pages for the dialog run
  const big = photo(await makePhoto(maker, { width: 4032, height: 3024, seed: 1 }));
  const bigFile = write('phone-12mp.jpg', big);
  const sideways = write('sideways.jpg', withOrientation(photo(await makePhoto(maker, { width: 1600, height: 1200, seed: 2 })), 6));
  const second = write('second.jpg', photo(await makePhoto(maker, { width: 1600, height: 1200, seed: 3 })));
  console.log(`sample 12 MP photo (4032 x 3024): ${kb(big.length)}`);

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.addInitScript((value) => {
    try { window.sessionStorage.setItem('warden.session', value); } catch { /* none */ }
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
  }, token);
  const page = await context.newPage();
  const consoleProblems = [];
  page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) consoleProblems.push(`${message.type()}: ${message.text()}`); });
  page.on('pageerror', (error) => consoleProblems.push(`pageerror: ${error.message}`));

  await page.goto(`${base}/files`);
  await page.getByRole('button', { name: 'Scan', exact: true }).waitFor({ timeout: 15000 });
  const storageState = () => page.evaluate(async () => ({
    local: Object.keys(window.localStorage),
    session: Object.keys(window.sessionStorage),
    idb: indexedDB.databases ? (await indexedDB.databases()).map((db) => db.name) : [],
    caches: window.caches ? await window.caches.keys() : [],
  }));
  const before = await storageState();

  // ---- scan 1: two pages, rotate, crop (mouse and keyboard), Document mode, PDF ----
  await page.getByRole('button', { name: 'Scan', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Scan documents' });
  await dialog.waitFor();
  const input = page.getByTestId('scan-input');
  check((await input.getAttribute('capture')) === 'environment' && (await input.getAttribute('accept')) === 'image/*', 'the input asks for the phone camera app (accept=image/*, capture=environment)');
  check(await dialog.getByText("Your phone's camera app may keep its own copy of the photo in your gallery. Delete it there after saving.").first().isVisible(), 'the gallery notice is shown');
  await input.setInputFiles(sideways);
  await dialog.getByRole('button', { name: 'Page 1' }).waitFor();
  const canvasSize = async () => dialog.locator('canvas').evaluate((c) => [c.width, c.height]);
  const [w1, h1] = await canvasSize();
  check(h1 > w1, `the sideways photo (EXIF orientation 6, 1600x1200) is drawn upright: preview ${w1}x${h1}`);
  await input.setInputFiles(second);
  await dialog.getByRole('button', { name: 'Page 2' }).waitFor();
  check((await dialog.getByText('2 of 10').count()) === 1, 'two pages, counted of 10');
  const [w2a, h2a] = await canvasSize();
  await dialog.getByRole('button', { name: 'Rotate right' }).click();
  await page.waitForFunction(([w, h]) => { const c = document.querySelector('[role=dialog] canvas'); return c && c.width === h && c.height === w; }, [w2a, h2a]);
  check(true, `rotate right turns page 2 (${w2a}x${h2a} -> ${h2a}x${w2a})`);
  // crop: drag the bottom-right corner with the mouse, then nudge the top-left one with the keyboard
  const box = async () => dialog.getByRole('group', { name: /Crop area/ }).boundingBox();
  const cropBefore = await box();
  const se = await dialog.getByRole('button', { name: /Crop corner, bottom right/ }).boundingBox();
  await page.mouse.move(se.x + se.width / 2, se.y + se.height / 2);
  await page.mouse.down();
  await page.mouse.move(se.x - 60, se.y - 50, { steps: 6 });
  await page.mouse.up();
  const cropMid = await box();
  check(cropMid.width < cropBefore.width - 30 && cropMid.height < cropBefore.height - 30, `dragging a corner shrinks the crop (${Math.round(cropBefore.width)}x${Math.round(cropBefore.height)} -> ${Math.round(cropMid.width)}x${Math.round(cropMid.height)})`);
  await dialog.getByRole('button', { name: /Crop corner, top left/ }).focus();
  for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowRight');
  const cropAfter = await box();
  check(cropAfter.width < cropMid.width - 1, 'the arrow keys nudge a corner');
  await dialog.getByRole('group', { name: /Crop area/ }).focus();
  const beforeMove = await box();
  await page.keyboard.press('Shift+ArrowLeft');
  check((await box()).x < beforeMove.x - 1, 'the arrow keys move the crop box');
  // Document mode and the threshold
  const pixels = () => dialog.locator('canvas').evaluate((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let colour = 0; for (let i = 0; i < d.length; i += 40) if (Math.abs(d[i] - d[i + 1]) > 6 || Math.abs(d[i + 1] - d[i + 2]) > 6) colour += 1; return colour; });
  const colourBefore = await pixels();
  await dialog.getByRole('checkbox', { name: /Document mode/ }).check();
  await page.waitForFunction(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
  const colourAfter = await pixels();
  check(colourBefore > 0 && colourAfter === 0, `Document mode makes the preview gray (coloured samples ${colourBefore} -> ${colourAfter})`);
  await dialog.getByRole('slider').fill('55');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'scan-edit-1280.png') });
  await dialog.getByRole('button', { name: 'Next: save' }).click();
  const name = 'Scan check 2026-10-15 14.32';
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Folder').selectOption('');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'scan-save-1280.png') });
  await dialog.getByLabel(/PDF \(all pages in one file\)/).check();
  await dialog.getByRole('button', { name: 'Save to the vault' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 60000 });

  // ---- the file ----
  const row = page.getByRole('button', { name: `${name}.pdf` }).first();
  await row.waitFor({ timeout: 15000 });
  check(true, `"${name}.pdf" is in the list`);
  const listed = (await api('GET', '/api/documents', { token })).body.find((doc) => doc.filename === `${name}.pdf`);
  check(Boolean(listed) && listed.size < 4 * 1024 * 1024, `it is ${kb(listed?.size ?? 0)}, under the 4 MB cap`);
  check(listed?.previewKind === 'pdf' && listed?.mimeType === 'application/pdf', `the server sniffed it as a PDF (previewKind ${listed?.previewKind}, type ${listed?.mimeType})`);
  const bytes = (await api('GET', `/api/documents/${listed.id}/view`, { token })).buffer;
  const body = bytes.toString('latin1');
  check(body.startsWith('%PDF-') && (body.match(/\/Type \/Page /g) || []).length === 2, 'the stored file starts with %PDF- and has 2 pages');
  const portrait = [...body.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => Number(m[1]) / Number(m[2]));
  check(portrait[0] < 1, `page 1 is portrait in the PDF (the EXIF turn was applied): ratio ${portrait[0]?.toFixed(2)}`);
  await row.click();
  const preview = page.getByRole('dialog').last();
  await preview.locator('canvas').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  const drawn = await preview.locator('canvas').first().evaluate((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let ink = 0; for (let i = 0; i < d.length; i += 400) if (d[i] < 128) ink += 1; return { w: c.width, h: c.height, ink }; });
  check(drawn.w > 50 && drawn.ink > 0, `the existing preview (pdf.js) opens it and draws the page (${drawn.w}x${drawn.h}, ${drawn.ink} dark samples)`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'scan-preview-1280.png') });
  await page.keyboard.press('Escape');

  // ---- scan 2: separate images into a folder ----
  await page.getByRole('button', { name: 'Scan', exact: true }).click();
  await dialog.waitFor();
  await input.setInputFiles(sideways);
  await dialog.getByRole('button', { name: 'Page 1' }).waitFor();
  await input.setInputFiles(second);
  await dialog.getByRole('button', { name: 'Page 2' }).waitFor();
  await dialog.getByRole('button', { name: 'Next: save' }).click();
  await dialog.getByLabel('Name').fill('Two pictures');
  await dialog.getByLabel('Folder').selectOption('Papers');
  await dialog.getByLabel(/Images \(JPEG\)/).check();
  await dialog.getByRole('button', { name: 'Save to the vault' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 60000 });
  await page.waitForTimeout(500);
  const docs = (await api('GET', '/api/documents', { token })).body;
  const jpgs = docs.filter((doc) => /^Two pictures page \d\.jpg$/.test(doc.filename));
  check(jpgs.length === 2 && jpgs.every((doc) => doc.folder === 'Papers' && doc.sniffedType === 'image/jpeg' && doc.size < 4 * 1024 * 1024), `separate JPEGs: ${jpgs.map((d) => `${d.filename} ${kb(d.size)}`).join(', ')} in the folder Papers`);

  // ---- scan 3: a 12 MP photo, as PDF and as JPEG (the sizes asked for) ----
  const saveOne = async (label, format) => {
    await page.getByRole('button', { name: 'Scan', exact: true }).click();
    await dialog.waitFor();
    await input.setInputFiles(bigFile);
    await dialog.getByRole('button', { name: 'Page 1' }).waitFor({ timeout: 30000 });
    await dialog.getByRole('button', { name: 'Next: save' }).click();
    await dialog.getByLabel('Name').fill(label);
    await dialog.getByLabel(format === 'pdf' ? /PDF \(all pages/ : /Images \(JPEG\)/).check();
    await dialog.getByRole('button', { name: 'Save to the vault' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 90000 });
    await page.waitForTimeout(400);
    return (await api('GET', '/api/documents', { token })).body.find((doc) => doc.filename === `${label}.${format === 'pdf' ? 'pdf' : 'jpg'}`);
  };
  const pdf12 = await saveOne('Phone photo as PDF', 'pdf');
  const jpg12 = await saveOne('Phone photo as JPEG', 'images');
  console.log(`12 MP photo (${kb(big.length)} original): as PDF ${kb(pdf12.size)}, as JPEG ${kb(jpg12.size)}`);
  check(pdf12.size < 4 * 1024 * 1024 && jpg12.size < 4 * 1024 * 1024, 'both are under the 4 MB cap');

  // ---- scan 4: ten full-size noisy pages at the cap ----
  const noisy = [];
  for (let i = 0; i < 10; i += 1) noisy.push(write(`noisy-${i}.jpg`, photo(await makePhoto(maker, { width: 3000, height: 4000, seed: 10 + i, grain: 60, quality: 0.95 }))));
  await page.getByRole('button', { name: 'Scan', exact: true }).click();
  await dialog.waitFor();
  for (const [index, file] of noisy.entries()) {
    await input.setInputFiles(file);
    await dialog.getByRole('button', { name: `Page ${index + 1}` }).waitFor({ timeout: 30000 });
  }
  check((await dialog.getByRole('button', { name: /Add page/ }).count()) === 0, 'at 10 pages "Add page" is gone');
  await dialog.getByRole('button', { name: 'Next: save' }).click();
  await dialog.getByLabel('Name').fill('Ten noisy pages');
  await dialog.getByRole('button', { name: 'Save to the vault' }).click();
  const outcome = await Promise.race([
    dialog.waitFor({ state: 'detached', timeout: 120000 }).then(() => 'saved'),
    dialog.getByRole('alert').first().waitFor({ timeout: 120000 }).then(() => 'refused'),
  ]);
  if (outcome === 'refused') {
    const text = await dialog.getByRole('alert').first().innerText();
    console.log(`ten noisy pages as one PDF: refused with: ${text.replace(/\s+/g, ' ')}`);
    check(/4 MB/.test(text) && /fewer pages/.test(text), 'a clear message, never a silent failure');
    const offered = await dialog.getByRole('button', { name: 'Save as separate images' }).count();
    check(offered === 1, 'it offers to save as separate images');
    await dialog.getByRole('button', { name: 'Save as separate images' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 180000 });
    const saved = (await api('GET', '/api/documents', { token })).body.filter((doc) => doc.filename.startsWith('Ten noisy pages page '));
    check(saved.length === 10 && saved.every((doc) => doc.size < 4 * 1024 * 1024), `the 10 pages were saved as ${saved.length} separate JPEGs, the largest ${kb(Math.max(...saved.map((d) => d.size)))}`);
  } else {
    const noisyDoc = (await api('GET', '/api/documents', { token })).body.find((doc) => doc.filename === 'Ten noisy pages.pdf');
    console.log(`ten noisy pages as one PDF: saved, ${kb(noisyDoc.size)}`);
    check(noisyDoc.size < 4 * 1024 * 1024, 'ten pages fit in one PDF under the cap by lowering the quality');
  }

  // ---- cancelling discards, and nothing was stored ----
  await page.getByRole('button', { name: 'Scan', exact: true }).click();
  await dialog.waitFor();
  await input.setInputFiles(second);
  await dialog.getByRole('button', { name: 'Page 1' }).waitFor();
  const countBefore = (await api('GET', '/api/documents', { token })).body.length;
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'detached' });
  check((await api('GET', '/api/documents', { token })).body.length === countBefore, 'cancel saves nothing');

  const after = await storageState();
  console.log(`browser storage before: ${JSON.stringify(before)}\nbrowser storage after:  ${JSON.stringify(after)}`);
  check(JSON.stringify(before) === JSON.stringify(after), 'the scanner added nothing to localStorage, sessionStorage, IndexedDB or the cache storage');
  check(after.local.length === 0 && after.idb.length === 0, 'localStorage and IndexedDB are empty');
  check(after.caches.every((key) => /^warden-shell-/.test(key)), `the only cache storage is the app's own shell cache, there before the scan (${after.caches.join(', ') || 'none'})`);
  const csp = await page.evaluate(() => window.__csp);
  check(csp.length === 0, `no CSP violations (${csp.join('; ') || 'none'})`);
  const bad = consoleProblems.filter((line) => /content security policy|refused to|violat/i.test(line));
  check(bad.length === 0, `no CSP messages in the console${bad.length ? `: ${bad.join(' | ')}` : ''}`);
  if (consoleProblems.length) console.log(`console warnings and errors (all): ${consoleProblems.length}\n  ${consoleProblems.slice(0, 6).join('\n  ')}`);
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
