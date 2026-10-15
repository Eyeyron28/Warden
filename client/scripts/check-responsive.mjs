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
import http from 'node:http';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const dist = path.join(root, 'client', 'dist');
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
const PUBLIC_PAGES = ['/', '/login', '/signup', '/forgot-password', '/privacy', '/terms', '/emergency'];
const APP_PAGES = ['/files', '/overview', '/devices', '/trash', '/shared', '/starred', '/recent'];

// ---------- the real app, locally ----------
const load = Module._load;
Module._load = function stubbed(request, ...rest) {
  return request === 'dotenv' ? { config: () => ({}), parse: () => ({}) } : load.call(this, request, ...rest);
};
for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM', 'VERCEL', 'INVITE_CODE', 'CRON_SECRET']) delete process.env[name];
Object.assign(process.env, { NODE_ENV: 'test', MONGO_URI: uri, SIGNUP_MODE: 'open', OTP_ENABLED: 'false', PUBLIC_APP_URL: 'https://warden.test', EMERGENCY_DEMO_MODE: 'false' });
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
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
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

let browser;
const rows = [];
let failures = 0;
try {
  const token = await seed();
  browser = await launch();
  for (const size of WIDTHS) {
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
        if (top.hScroll || scrolled.hScroll) problems.push(`horizontal scroll: ${top.hScroll || scrolled.hScroll}`);
        for (const text of new Set([...top.overlaps, ...scrolled.overlaps])) problems.push(`overlap: ${text}`);
        const redirected = new URL(page.url()).pathname !== route && !(route === '/signup' || route === '/login' || route === '/forgot-password') ? ` (went to ${new URL(page.url()).pathname})` : '';
        rows.push({ route, size: size.name, ok: problems.length === 0, problems, bars: Math.max(top.bars, scrolled.bars), redirected, apiCalls, callList });
        if (problems.length) failures += 1;
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
const routes = [...PUBLIC_PAGES, ...APP_PAGES];
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
console.log(`\n${rows.length} page loads, ${failures} with problems.`);
process.exit(failures ? 1 : 0);
