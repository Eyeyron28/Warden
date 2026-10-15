// npm run check:responsive
//
// Loads the public pages and, with a seeded throwaway account, the signed-in pages (Files, Overview, Devices, Trash, Shared) at
// 360, 768 and 1280 px, and fails on horizontal scroll or on fixed/sticky bars that overlap each other (checked at the top of the
// page and after scrolling). It starts its own copy of the real app (the API and client/dist) against a LOCAL throwaway MongoDB:
//   - the database is 127.0.0.1:27099 by default, or WARDEN_TEST_MONGO, which must be local (anything else is refused);
//   - no .env file is read (dotenv is replaced), nothing connects to Atlas, mail is captured and never sent;
//   - the database it makes is dropped at the end.
// Build the client first (npm run build). The browser is the Chromium Playwright finds (PLAYWRIGHT_BROWSERS_PATH, e.g.
// /opt/pw-browsers), or PW_CHROMIUM_PATH, or an installed Chrome or Edge. This script never downloads a browser.
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import zlib from 'node:zlib';

import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const dist = process.env.DIST_DIR ? path.resolve(process.env.DIST_DIR) : path.join(root, 'client', 'dist');
const requireServer = createRequire(path.join(root, 'server', 'package.json'));

const DEFAULT_URI = 'mongodb://127.0.0.1:27099/?replicaSet=rs0&directConnection=true';
const baseUri = process.env.WARDEN_TEST_MONGO || DEFAULT_URI;
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(baseUri)) {
  console.error('WARDEN_TEST_MONGO must point at a local MongoDB (127.0.0.1 or localhost). Refusing.');
  process.exit(2);
}
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('client/dist is missing. Run "npm run build" in client first.');
  process.exit(2);
}
const uri = baseUri.replace(/^(mongodb:\/\/[^/]+)\/[^?]*/, '$1/warden_responsive_check');

const WIDTHS = [
  { name: '360', width: 360, height: 800 },
  { name: '768', width: 768, height: 1024 },
  { name: '1280', width: 1280, height: 800 },
];
const LONG_ASCII = `${'Quarterly_financial_statements_and_supporting_schedules_'.repeat(5).slice(0, 251)}.pdf`;
const LONG_UNICODE = `${'\u5c65\u6b74\u66f8_\u8077\u52d9\u7d4c\u6b74\u66f8_Ünïcödé_'.repeat(9)}final.pdf`;
// The dialogs are tried at these sizes (the last is a small laptop).
const DIALOG_SIZES = [
  { name: '320', width: 320, height: 640 },
  { name: '360', width: 360, height: 800 },
  { name: '768', width: 768, height: 1024 },
  { name: '1280', width: 1280, height: 800 },
  { name: '1366x768', width: 1366, height: 768 },
];
const PUBLIC_PAGES = ['/', '/login', '/signup', '/forgot-password', '/privacy', '/terms', '/emergency'];
const APP_PAGES = ['/files', '/overview', '/devices', '/trash', '/shared', '/starred', '/recent'];

// ---------- the real app, locally ----------
const load = Module._load;
Module._load = function stubbed(request, ...rest) {
  return request === 'dotenv' ? { config: () => ({}), parse: () => ({}) } : load.call(this, request, ...rest);
};
for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM', 'VERCEL', 'INVITE_CODE', 'CRON_SECRET']) delete process.env[name];
Object.assign(process.env, { NODE_ENV: 'test', MONGO_URI: uri, SIGNUP_MODE: 'open', OTP_ENABLED: 'false', PUBLIC_APP_URL: 'https://warden.test', EMERGENCY_DEMO_MODE: 'false', CORS_ORIGINS: 'http://127.0.0.1:5059' });
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

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api')) return app(req, res);
  let file = path.join(dist, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  return res.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(5059, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function api(method, route, { token, json, form } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  let body;
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  if (form) body = form;
  await mongoose.models.RateLimit.deleteMany({});
  const response = await fetch(base + route, { method, headers, body });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: null };
  }
}

async function seed() {
  const email = 'responsive.check@example.com';
  const password = 'Qx7!vTr29#mLpw';
  await api('POST', '/api/auth/signup/start', { json: { email, password, termsAccepted: true } });
  const code = /(?<![\d-])(\d{6})(?![\d-])/.exec(mails.at(-1).text)[1];
  const verified = await api('POST', '/api/auth/signup/verify', { json: { email, password, code } });
  const token = verified.body.sessionToken;
  await api('POST', '/api/documents/folders', { token, json: { name: 'Taxes', parentPath: '', color: 'blue', icon: 'receipt' } });
  await api('POST', '/api/documents/folders', { token, json: { name: 'Health records', parentPath: '', color: 'rose', icon: 'heart' } });
  const ids = [];
  for (let i = 0; i < 12; i += 1) {
    const form = new FormData();
    form.append('file', new Blob([`document number ${i} `.repeat(20)], { type: 'text/plain' }), `a-fairly-long-document-name-number-${i}.txt`);
    if (i % 3 === 0) form.append('folder', 'Taxes');
    ids.push((await api('POST', '/api/documents', { token, form })).body.id);
  }
  await api('DELETE', `/api/documents/${ids[11]}`, { token });
  await api('POST', '/api/documents/star', { token, json: { ids: [ids[0], ids[3]], starred: true } });
  for (const id of ids.slice(0, 4)) await api('GET', `/api/documents/${id}/view`, { token });
  // A private note (one long unbroken word, to try the layout) and two earlier versions on every live file, so the notes box and
  // the Versions section are there whichever file's details open.
  for (const [n, id] of ids.slice(0, 11).entries()) {
    await api('PUT', `/api/documents/${id}/note`, { token, json: { note: `Original is in the blue folder, drawer ${n}.\n${'x'.repeat(60)}-unbroken-word-to-test-wrapping\nCall the office before Friday.` } });
    for (const round of [1, 2]) {
      const form = new FormData();
      form.append('file', new Blob([`document number ${n} revised ${round} `.repeat(30)], { type: 'text/plain' }), 'ignored.txt');
      await api('POST', `/api/documents/${id}/versions`, { token, form });
    }
  }
  // Two files with very long names (255 characters with no space or hyphen to break at, which is the case that overflows; and a long Unicode name): the dialogs below must cope with both.
  for (const name of [LONG_ASCII, LONG_UNICODE]) {
    const form = new FormData();
    form.append('file', new Blob(['long name document '.repeat(20)], { type: 'text/plain' }), name);
    await api('POST', '/api/documents', { token, form });
  }
  await api('POST', `/api/documents/${ids[1]}/share`, { token, json: { durationHours: 24 } });
  await api('PATCH', `/api/documents/${ids[2]}`, { token, json: { docExpiresAt: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10) } });
  return token;
}

// ---------- the checks, run inside the page ----------
function inPage() {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
  };
  const bars = [...document.querySelectorAll('body *')].filter((el) => {
    const position = getComputedStyle(el).position;
    return (position === 'fixed' || position === 'sticky') && visible(el);
  });
  const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.split(' ')[0].replace(/_[a-z0-9]{5,}$/i, '')}` : ''}`;
  const overlaps = [];
  for (let i = 0; i < bars.length; i += 1) {
    for (let j = i + 1; j < bars.length; j += 1) {
      const a = bars[i];
      const b = bars[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const width = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const height = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (width > 2 && height > 2) overlaps.push(`${describe(a)} over ${describe(b)} (${Math.round(width)}x${Math.round(height)})`);
    }
  }
  const doc = document.documentElement;
  // When the page is too wide, name the widest things that stick out of the window (not those inside a scrolling box).
  const insideScroller = (el) => {
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(node).overflowX)) return true;
    }
    return false;
  };
  const wide = doc.scrollWidth > doc.clientWidth + 1
    ? [...document.querySelectorAll('body *')]
        .filter((el) => visible(el) && el.getBoundingClientRect().right > doc.clientWidth + 1 && !insideScroller(el))
        .map((el) => `${describe(el)} ends at ${Math.round(el.getBoundingClientRect().right)}px`)
        .slice(0, 3)
    : [];
  return {
    hScroll: doc.scrollWidth > doc.clientWidth + 1 ? `${doc.scrollWidth}px wide in ${doc.clientWidth}px${wide.length ? ` (${wide.join('; ')})` : ''}` : null,
    overlaps,
    bars: bars.length,
  };
}

async function launch() {
  const attempts = [
    process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
    { channel: 'chrome' },
    { channel: 'msedge' },
  ];
  let last;
  for (const options of attempts) {
    try {
      return await chromium.launch({ headless: true, ...options });
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`No Chromium found (set PLAYWRIGHT_BROWSERS_PATH or PW_CHROMIUM_PATH, or install Chrome or Edge): ${String(last?.message).split('\n')[0]}`);
}

// A small gray-gradient PNG for the Scan dialog (built here, so no file or library is needed).
function samplePng(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buffer) => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4); return out; };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) { const at = y * (width * 3 + 1) + 1 + x * 3; const v = 90 + Math.round((x / width) * 120) - (y % 40 < 3 ? 70 : 0); raw[at] = v; raw[at + 1] = v - 6; raw[at + 2] = v - 12; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const scanSample = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'warden-resp-')), 'sample.png');
fs.writeFileSync(scanSample, samplePng(900, 1200));

let browser;
const rows = [];
const dialogRows = [];
let failures = 0;
try {
  const token = await seed();
  browser = await launch();
  // ONLY_DIALOGS=1 skips the page matrix and runs just the long-name dialogs and the Folders/Files blocks.
  for (const size of process.env.ONLY_DIALOGS ? [] : WIDTHS) {
    for (const [signedIn, pages] of [[false, PUBLIC_PAGES], [true, APP_PAGES]]) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, reducedMotion: 'reduce', colorScheme: process.env.THEME === 'dark' ? 'dark' : 'light' });
      if (signedIn) await context.addInitScript((value) => { try { window.sessionStorage.setItem('warden.session', value); } catch { /* none */ } }, token);
      const page = await context.newPage();
      for (const route of pages) {
        let apiCalls = 0;
        const callList = [];
        const count = (request) => { const where = new URL(request.url()).pathname; if (where.startsWith('/api/')) { apiCalls += 1; callList.push(`${request.method()} ${where}`); } };
        page.on('request', count);
        await page.goto(base + route, { waitUntil: 'networkidle' });
        page.off('request', count);
        await page.addStyleTag({ content: '*{transition:none!important;animation:none!important}' });
        await page.waitForTimeout(250);
        if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${route.replace(/\//g, '_') || 'home'}-${process.env.THEME || 'light'}-${size.name}.png`) });
        const top = await page.evaluate(inPage);
        await page.evaluate(() => window.scrollTo(0, Math.min(700, document.documentElement.scrollHeight)));
        await page.waitForTimeout(150);
        const scrolled = await page.evaluate(inPage);
        const problems = [];
        // The details panel (a drawer, or a sheet on a phone): opens from a file's info button, stays inside the screen, is closed by Escape.
        if (route === '/files' || route === '/starred' || route === '/recent') {
          await page.evaluate(() => window.scrollTo(0, 0));
          const info = page.locator('button[aria-label^="Details for"]').first();
          if (await info.count()) {
            await info.click();
            const panel = page.getByRole('dialog', { name: /^Details for/ });
            await panel.waitFor({ timeout: 8000 });
            await page.waitForFunction(() => document.querySelector('[role=dialog] dl'), null, { timeout: 8000 }).catch(() => {});
            // The notes box and the Versions section, and that nothing in them pushes the panel sideways.
            const notes = panel.locator('textarea');
            if ((await notes.count()) !== 1) problems.push('details panel has no notes box');
            else if (!(await notes.inputValue()).includes('unbroken-word')) problems.push('the saved note is not in the box');
            if (!(await panel.getByText('Versions are kept for 30 days, up to 3 per file.').count())) problems.push('details panel has no Versions section');
            if ((await panel.getByRole('button', { name: /^Restore version/ }).count()) < 1) problems.push('no Restore button on a version');
            if (!(await panel.getByRole('button', { name: /Upload new version/ }).count())) problems.push('no Upload new version button');
            await panel.locator('[class*=versions]').first().scrollIntoViewIfNeeded().catch(() => {});
            const sideways = await page.evaluate(() => [...document.querySelectorAll('[role=dialog] *')].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible' && el.getBoundingClientRect().right > window.innerWidth + 1).map((el) => el.className).slice(0, 3));
            if (sideways.length) problems.push(`details panel content runs off the right edge: ${sideways.join(', ')}`);
            if (process.env.SHOTS && route === '/files') await page.screenshot({ path: path.join(process.env.SHOTS, `files-versions-${process.env.THEME || 'light'}-${size.name}.png`) });
            if (process.env.SHOTS && route === '/files') await page.screenshot({ path: path.join(process.env.SHOTS, `files-details-${process.env.THEME || 'light'}-${size.name}.png`) });
            const box = await panel.boundingBox();
            const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
            if (!box || box.x < -1 || box.y < -1 || box.x + box.width > size.width + 1 || box.y + box.height > size.height + 1) problems.push(`details panel outside the screen (${JSON.stringify(box)})`);
            if (wide) problems.push('details panel made the page scroll sideways');
            await page.keyboard.press('Escape');
            await page.getByRole('dialog', { name: /^Details for/ }).waitFor({ state: 'detached', timeout: 4000 }).catch(() => problems.push('Escape did not close the details panel'));
          } else problems.push('no details button found');
        }
        // The Scan dialog: opens from the Scan button, takes a page, shows the editor and the save step inside the screen.
        if (route === '/files') {
          await page.evaluate(() => window.scrollTo(0, 0));
          const scan = page.getByRole('button', { name: 'Scan', exact: true });
          if (!(await scan.isVisible())) problems.push('the Scan button is not visible');
          else {
            await scan.click();
            const dialog = page.getByRole('dialog', { name: 'Scan documents' });
            await dialog.waitFor({ timeout: 8000 });
            const inside = async (label) => {
              const found = await dialog.boundingBox();
              const sideways = await dialog.evaluate((el) => [...el.querySelectorAll('*')].some((node) => node.getBoundingClientRect().right > el.getBoundingClientRect().right + 1 && getComputedStyle(node).position !== 'absolute'));
              if (!found || found.x < -1 || found.x + found.width > size.width + 1 || found.y + found.height > size.height + 1) problems.push(`Scan dialog (${label}) outside the screen (${JSON.stringify(found)})`);
              if (sideways) problems.push(`Scan dialog (${label}) has content past its right edge`);
            };
            await inside('start');
            await page.getByTestId('scan-input').setInputFiles(scanSample);
            await dialog.getByRole('button', { name: 'Page 1' }).waitFor({ timeout: 8000 });
            await page.waitForTimeout(300);
            await inside('editor');
            for (const label of [/Crop corner, top left/, /Crop corner, bottom right/]) {
              const handle = await dialog.getByRole('button', { name: label }).boundingBox();
              if (!handle || handle.x < 0 || handle.y < 0 || handle.x + handle.width > size.width + 1 || handle.y + handle.height > size.height + 1) problems.push(`a crop handle is off the screen (${label})`);
            }
            if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `scan-editor-${process.env.THEME || 'light'}-${size.name}.png`) });
            await dialog.getByRole('button', { name: 'Next: save' }).scrollIntoViewIfNeeded();
            await dialog.getByRole('button', { name: 'Next: save' }).click();
            await dialog.getByRole('button', { name: 'Save to the vault' }).waitFor({ timeout: 8000 });
            await inside('save');
            if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `scan-save-${process.env.THEME || 'light'}-${size.name}.png`) });
            await page.keyboard.press('Escape');
            await dialog.waitFor({ state: 'detached', timeout: 4000 }).catch(() => problems.push('Escape did not close the Scan dialog'));
          }
        }
        if (top.hScroll || scrolled.hScroll) problems.push(`horizontal scroll: ${top.hScroll || scrolled.hScroll}`);
        for (const text of new Set([...top.overlaps, ...scrolled.overlaps])) problems.push(`overlap: ${text}`);
        const redirected = new URL(page.url()).pathname !== route && !(route === '/signup' || route === '/login' || route === '/forgot-password') ? ` (went to ${new URL(page.url()).pathname})` : '';
        rows.push({ route, size: size.name, ok: problems.length === 0, problems, bars: Math.max(top.bars, scrolled.bars), redirected, apiCalls, callList });
        if (problems.length) failures += 1;
      }
      await context.close();
    }
  }

  // ---------- long names in dialogs, and the Folders / Files blocks ----------
  // For each dialog: it is inside the screen, nothing sideways-scrolls, no control sticks out of it or overlaps another. The
  // Share dialog is two columns from 760 px and one below, and fits a 1366x768 screen without scrolling.
  let currentKind = '';
  const inspect = async (page, dialog, label, size, { expectColumns } = {}) => {
    const out = [];
    const found = await dialog.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      // What is really on screen: not in a closed <details>, and only the part a scrolling box (or the dialog) does not cut off.
      const shown = (node) => {
        if (node.closest('[hidden]')) return null;
        const details = node.closest('details:not([open])');
        if (details && !node.closest('summary')) return null;
        const cs = getComputedStyle(node);
        if (cs.visibility === 'hidden' || cs.display === 'none') return null;
        const r = node.getBoundingClientRect();
        let box = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        for (let up = node.parentElement; up && up !== el.parentElement; up = up.parentElement) {
          const o = getComputedStyle(up);
          if (o.overflowX !== 'visible' || o.overflowY !== 'visible') {
            const c = up.getBoundingClientRect();
            box = { left: Math.max(box.left, c.left), right: Math.min(box.right, c.right), top: Math.max(box.top, c.top), bottom: Math.min(box.bottom, c.bottom) };
          }
        }
        return box.right - box.left > 0 && box.bottom - box.top > 0 ? { box, own: r } : null;
      };
      const visibleEl = (node) => shown(node) !== null;
      const controls = [...el.querySelectorAll('button, input:not([type=hidden]):not([hidden]), select, textarea, a[href], summary')].filter(visibleEl);
      const outside = controls.filter((node) => { const r = shown(node).own; return r.left < rect.left - 1 || r.right > rect.right + 1; }).map((node) => `${node.tagName.toLowerCase()} "${(node.getAttribute('aria-label') || node.textContent || node.value || '').trim().slice(0, 30)}"`);
      const overlaps = [];
      for (let i = 0; i < controls.length; i += 1) for (let j = i + 1; j < controls.length; j += 1) {
        const a = shown(controls[i]).box; const b = shown(controls[j]).box;
        if (controls[i].contains(controls[j]) || controls[j].contains(controls[i])) continue;
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left); const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 3 && h > 3) overlaps.push(`"${(controls[i].getAttribute('aria-label') || controls[i].textContent || '').trim().slice(0, 20)}" over "${(controls[j].getAttribute('aria-label') || controls[j].textContent || '').trim().slice(0, 20)}"`);
      }
      const scrollers = [el, ...el.querySelectorAll('*')].filter((node) => node.scrollWidth > node.clientWidth + 1 && ['auto', 'scroll'].includes(getComputedStyle(node).overflowX)).map((node) => String(node.className).slice(0, 40));
      const clippedLeft = [...el.querySelectorAll('h2, h3, label, p, li, button, summary')].filter(visibleEl).filter((node) => node.getBoundingClientRect().left < rect.left - 1).map((node) => (node.textContent || '').trim().slice(0, 30));
      const header = el.querySelector('h2');
      const close = el.querySelector('button[aria-label="Close"], button[aria-label^="Close"]');
      const closeRect = close ? close.getBoundingClientRect() : null;
      const bodyScrollers = [...el.querySelectorAll('*')].filter((node) => shown(node) && node.scrollHeight > node.clientHeight + 2 && ['auto', 'scroll'].includes(getComputedStyle(node).overflowY)).map((node) => `${String(node.className).slice(0, 24)} +${node.scrollHeight - node.clientHeight}px`);
      const columns = [...el.querySelectorAll('section[aria-labelledby]')].map((node) => Math.round(node.getBoundingClientRect().left));
      const short = controls.filter((node) => node.tagName === 'BUTTON' && node.getBoundingClientRect().height < 43 && node.getBoundingClientRect().width > 20 && !/^(Copy|Close)$/.test(node.getAttribute('aria-label') || '')).length;
      return { rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }, outside, overlaps, scrollers, clippedLeft, headerWide: header ? header.scrollWidth > header.clientWidth + 1 && getComputedStyle(header).textOverflow !== 'ellipsis' : false, closeVisible: closeRect ? closeRect.right <= window.innerWidth + 1 && closeRect.left >= 0 : null, bodyScrollers, columns, short };
    });
    const { rect } = found;
    if (rect.x < -1 || rect.y < -1 || rect.x + rect.w > size.width + 1 || rect.y + rect.h > size.height + 1) out.push(`outside the screen ${JSON.stringify(rect)}`);
    if (found.scrollers.length) out.push(`horizontal scrollbar in: ${found.scrollers.join(', ')}`);
    if (found.outside.length) out.push(`controls stick out of the dialog: ${found.outside.slice(0, 3).join(', ')}`);
    if (found.clippedLeft.length) out.push(`text clipped on the left: ${found.clippedLeft.slice(0, 2).join(' | ')}`);
    if (found.overlaps.length) out.push(`overlapping controls: ${found.overlaps.slice(0, 3).join(', ')}`);
    if (found.headerWide) out.push('the title is wider than its box and not cut with an ellipsis');
    if (found.closeVisible === false) out.push('the close button is off the screen');
    if (expectColumns === 2 && new Set(found.columns).size !== 2) out.push(`expected two columns, found left edges ${found.columns.join(',')}`);
    if (expectColumns === 1 && new Set(found.columns).size > 1) out.push(`expected one column, found left edges ${found.columns.join(',')}`);
    if (size.name === '1366x768' && label === 'Share' && found.bodyScrollers.length > 0) out.push(`the Share dialog scrolls at 1366x768 (${found.bodyScrollers.join(', ')})`);
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `dialog-${label.toLowerCase().replace(/[^a-z]/g, '')}-${currentKind}-${process.env.THEME || 'light'}-${size.name}.png`) });
    return out;
  };
  const openMenuItem = async (page, name, item) => {
    const trigger = page.getByRole('button', { name: `More actions for ${name}`, exact: true });
    // Scroll the row into view FIRST and let the scrolling stop: a menu closes when the page scrolls under it.
    await trigger.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await trigger.click();
    const entry = page.getByRole('menuitem', { name: item });
    try {
      await entry.click({ timeout: 4000 });
    } catch {
      const items = await page.getByRole('menuitem').evaluateAll((nodes) => nodes.map((node) => `${node.textContent.trim().slice(0, 18)}@${Math.round(node.getBoundingClientRect().top)}-${Math.round(node.getBoundingClientRect().bottom)}`));
      throw new Error(`menu item "${item}" could not be clicked; menu items: ${items.join(' | ')}; viewport height ${page.viewportSize().height}`);
    }
  };
  for (const size of DIALOG_SIZES) {
    for (const [kind, longName] of [['ascii', LONG_ASCII], ['unicode', LONG_UNICODE]]) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, reducedMotion: 'reduce', colorScheme: process.env.THEME === 'dark' ? 'dark' : 'light' });
      await context.addInitScript((value) => { try { window.sessionStorage.setItem('warden.session', value); } catch { /* none */ } }, token);
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      currentKind = kind;
      await page.goto(base + '/files', { waitUntil: 'networkidle' });
      const record = (label, problems) => { dialogRows.push({ label: `${label} (${kind})`, size: size.name, problems }); if (problems.length) failures += 1; };
      const attempt = async (label, work) => {
        await page.waitForTimeout(300); // the previous dialog has finished closing
        try { record(label, await work()); } catch (error) {
          record(label, [`could not be checked: ${String(error.message).split('\n')[0]}`]);
          if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `failed-${label.toLowerCase().replace(/[^a-z]/g, '')}-${kind}-${size.name}.png`) }).catch(() => {});
        }
        await page.keyboard.press('Escape').catch(() => {});
        // Escape must close the dialog: if one is still there a moment later, that is a problem of its own.
        await page.waitForFunction(() => !document.querySelector('[aria-modal="true"]'), null, { timeout: 2500 }).catch(async () => {
          dialogRows.push({ label: `${label} (${kind})`, size: size.name, problems: ['Escape did not close the dialog'] });
          failures += 1;
          await page.getByRole('button', { name: 'Close' }).last().click().catch(() => {});
        });
        await page.waitForTimeout(100);
      };

      await attempt('Upload', async () => {
        await page.getByRole('button', { name: 'New' }).click();
        await page.getByRole('menuitem', { name: /Upload file/ }).click();
        const dialog = page.getByRole('dialog', { name: 'Upload file' });
        await dialog.waitFor({ timeout: 8000 });
        await dialog.locator('input[type=file]').setInputFiles({ name: longName, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% sample\n') });
        await page.waitForTimeout(200);
        const found = await inspect(page, dialog, 'Upload', size);
        const titled = await dialog.locator('button[title]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title')));
        if (!titled.includes(longName)) found.push('the full name is not the tooltip of the file button');
        if (!(await dialog.locator('button[aria-label*="Chosen file"]').count())) found.push('the file button has no accessible name with the file name');
        return found;
      });
      await attempt('Rename', async () => {
        await openMenuItem(page, longName, 'Rename');
        const dialog = page.getByRole('dialog', { name: /^Edit "/ });
        await dialog.waitFor({ timeout: 8000 });
        return inspect(page, dialog, 'Rename', size);
      });
      await attempt('Move', async () => {
        await openMenuItem(page, longName, 'Move to…');
        const dialog = page.getByRole('dialog', { name: /^Move/ });
        await dialog.waitFor({ timeout: 8000 });
        return inspect(page, dialog, 'Move', size);
      });
      await attempt('Share', async () => {
        await openMenuItem(page, longName, 'Share');
        const dialog = page.getByRole('dialog', { name: /^Share/ });
        await dialog.waitFor({ timeout: 8000 });
        const found = await inspect(page, dialog, 'Share (before)', size, { expectColumns: size.width >= 760 ? 2 : 1 });
        await dialog.getByLabel(/^Password/).fill('Correct-Horse-9!');
        await dialog.getByLabel(/^Only this email/).fill('someone.with.a.long.address@example.com');
        await dialog.getByLabel(/^Purpose/).fill('For a very long purpose text that goes on');
        await dialog.getByRole('button', { name: /Generate share link/ }).click();
        await dialog.getByRole('textbox', { name: 'Share link', exact: true }).waitFor({ timeout: 20000 });
        if (size.width < 760) await dialog.getByRole('button', { name: /QR code/ }).click();
        await dialog.getByAltText('QR code for the share link').waitFor({ timeout: 25000 });
        await page.waitForTimeout(300);
        found.push(...(await inspect(page, dialog, 'Share', size, { expectColumns: size.width >= 760 ? 2 : 1 })));
        const buttons = await dialog.getByRole('group', { name: /Send the link with an app/ }).locator('a, button').count();
        if (buttons < 5) found.push(`only ${buttons} share-to buttons are there`);
        const qr = await dialog.getByAltText('QR code for the share link').boundingBox();
        if (!qr || Math.abs(qr.width - qr.height) > 2) found.push('the QR code is not a square');
        const header = await dialog.locator('h2').evaluate((node) => [node.getAttribute('title')?.length, getComputedStyle(node).whiteSpace]);
        if (header[1] !== 'nowrap') found.push('the title can wrap onto several lines');
        if (!(header[0] > 120)) found.push('the full name is not the title tooltip');
        return found;
      });
      await attempt('Details', async () => {
        await page.getByRole('button', { name: `Details for ${longName}`, exact: true }).click();
        const dialog = page.getByRole('dialog', { name: /^Details for/ });
        await dialog.waitFor({ timeout: 8000 });
        await page.waitForFunction(() => document.querySelector('[role=dialog] dl'), null, { timeout: 8000 }).catch(() => {});
        return inspect(page, dialog, 'Details', size);
      });
      if (kind === 'ascii') {
        await attempt('Scan', async () => {
          await page.getByRole('button', { name: 'Scan', exact: true }).click();
          const dialog = page.getByRole('dialog', { name: 'Scan documents' });
          await dialog.waitFor({ timeout: 8000 });
          await page.getByTestId('scan-input').setInputFiles(scanSample);
          await dialog.getByRole('button', { name: 'Page 1' }).waitFor({ timeout: 8000 });
          await dialog.getByRole('button', { name: 'Next: save' }).click();
          await dialog.getByLabel('Name').fill(longName.slice(0, 100));
          return inspect(page, dialog, 'Scan save', size);
        });
      }

      // The Folders and Files blocks (the page itself, not a dialog)
      if (kind === 'ascii' && ['360', '768', '1280'].includes(size.name)) {
        const blocks = [];
        const headings = await page.getByRole('heading', { level: 2 }).allInnerTexts();
        const names = headings.map((text) => text.replace(/\s+/g, ' ').trim());
        if (!names.some((text) => /^Folders \d+$/.test(text))) blocks.push(`no "Folders" block heading (${names.join(' | ')})`);
        if (!names.some((text) => /^Files \d+$/.test(text))) blocks.push('no "Files" block heading');
        const order = await page.evaluate(() => {
          const folders = document.querySelector('#folders-heading'); const files = document.querySelector('#files-heading');
          const tiles = [...document.querySelectorAll('ul[aria-label="Folders"] > li')];
          const fileRows = [...document.querySelectorAll('ul[aria-label="Files"] > li')];
          const divider = document.querySelector('hr');
          const gap = folders && files && tiles.length ? files.getBoundingClientRect().top - tiles.at(-1).getBoundingClientRect().bottom : null;
          const columns = new Set(tiles.map((tile) => Math.round(tile.getBoundingClientRect().left))).size;
          return { foldersFirst: Boolean(folders && files && folders.getBoundingClientRect().top < files.getBoundingClientRect().top), tiles: tiles.length, rowsAreFolders: fileRows.filter((row) => row.querySelector('[aria-label^="Select "]') && /\bitem(s)?\b/.test(row.textContent || '') && !row.querySelector('button[aria-label^="Star"]')).length, hasDivider: Boolean(divider), gap, columns };
        });
        if (!order.foldersFirst) blocks.push('Folders is not above Files');
        if (order.tiles < 2) blocks.push(`expected the seeded folders as tiles, found ${order.tiles}`);
        if (order.rowsAreFolders > 0) blocks.push('a folder appears among the file rows');
        if (!order.hasDivider) blocks.push('no divider between the blocks');
        if (order.gap !== null && (order.gap < 20 || order.gap > 90)) blocks.push(`the gap between the blocks is ${Math.round(order.gap)} px`);
        if (size.name === '360' && order.columns !== 2) blocks.push(`a phone should show 2 columns of folder tiles, found ${order.columns}`);
        if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `blocks-${process.env.THEME || 'light'}-${size.name}.png`) });
        record('Folders and Files blocks', blocks);
      }
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

// ---------- the table ----------
const pad = (text, n) => String(text).padEnd(n);
const routes = process.env.ONLY_DIALOGS ? [] : [...PUBLIC_PAGES, ...APP_PAGES];
console.log(`\n${pad('page', 20)}${WIDTHS.map((w) => pad(`${w.name}px`, 9)).join('')}`);
for (const route of routes) {
  const cells = WIDTHS.map((size) => {
    const row = rows.find((r) => r.route === route && r.size === size.name);
    return pad(row?.ok ? 'ok' : 'FAIL', 9);
  });
  console.log(`${pad(route, 20)}${cells.join('')}`);
}
for (const row of rows.filter((r) => !r.ok)) console.log(`\nFAIL ${row.route} at ${row.size}px: ${row.problems.join('; ')}`);
for (const row of rows.filter((r) => r.redirected)) console.log(`note: ${row.route} at ${row.size}px${row.redirected}`);
console.log('\nAPI requests on a cold load of each signed-in page (1280px):');
for (const row of rows.filter((r) => r.size === '1280' && APP_PAGES.includes(r.route))) console.log(`  ${pad(row.route, 12)} ${row.apiCalls}${process.env.LIST_CALLS ? `  ${row.callList.join(', ')}` : ''}`);
const dialogKinds = [...new Set(dialogRows.map((r) => r.label))];
if (dialogKinds.length) {
  console.log(`\n${pad('long names in dialogs', 34)}${DIALOG_SIZES.map((w) => pad(w.name, 10)).join('')}`);
  for (const label of dialogKinds) {
    console.log(`${pad(label, 34)}${DIALOG_SIZES.map((size) => { const row = dialogRows.find((r) => r.label === label && r.size === size.name); return pad(!row ? '-' : row.problems.length ? 'FAIL' : 'ok', 10); }).join('')}`);
  }
  for (const row of dialogRows.filter((r) => r.problems.length)) console.log(`\nFAIL ${row.label} at ${row.size}: ${row.problems.join('; ')}`);
}
console.log(`\n${rows.length} page loads and ${dialogRows.length} dialog checks, ${failures} with problems.`);
process.exit(failures ? 1 : 0);
