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
const uri = baseUri.replace(/^(mongodb:\/\/[^/]+)\/[^?]*/, '$1/warden_tooltips_check');

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-tooltips-'));


const LIST = Boolean(process.env.LIST);
const THEME = process.env.THEME === 'dark' ? 'dark' : 'light';

function findUnnamed() {
  const selector = 'button, a[href], [role="button"], [role="menuitem"], [role="tab"], summary, input[type="checkbox"], input[type="radio"]';
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width <= 0 || r.height <= 0 || cs.visibility === 'hidden' || cs.display === 'none') return false;
    if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight + 4000) return false;
    if (el.closest('[aria-hidden="true"]') && !el.closest('[role="dialog"]')) return false;
    if (el.matches('input[type="file"]')) return false;
    if (r.width <= 1 && r.height <= 1) return false;
    return true;
  };
  const nameOf = (el) => {
    const label = (el.getAttribute('aria-label') || '').trim();
    if (label) return label;
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
      if (text) return text;
    }
    if (el.matches('input')) {
      const text = [...(el.labels || [])].map((l) => l.textContent).join(' ').trim();
      if (text) return text;
    }
    const text = (el.innerText || '').trim();
    if (text) return text;
    const img = el.querySelector('img[alt]');
    if (img && img.alt.trim()) return img.alt.trim();
    const svgTitle = el.querySelector('svg title');
    if (svgTitle && svgTitle.textContent.trim()) return svgTitle.textContent.trim();
    return (el.getAttribute('title') || '').trim();
  };
  const describe = (el) => {
    const cls = String(el.className || '').split(/\s+/).map((c) => c.replace(/^_/, '').replace(/_[A-Za-z0-9-]{5,}$/, '')).filter(Boolean).join('.');
    const parent = el.parentElement ? `${el.parentElement.tagName.toLowerCase()}.${String(el.parentElement.className || '').split(/\s+/)[0].replace(/^_/, '').replace(/_[A-Za-z0-9-]{5,}$/, '')}` : '';
    return `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''}.${cls || '-'} in ${parent}${el.getAttribute('href') ? ` href=${el.getAttribute('href')}` : ''}`;
  };
  const all = [...document.querySelectorAll(selector)].filter(visible);
  const ownName = (el) => {
    const keep = el.getAttribute('title');
    el.removeAttribute('title');
    const name = nameOf(el);
    if (keep !== null) el.setAttribute('title', keep);
    return name;
  };
  return {
    unnamed: all.filter((el) => !nameOf(el)).map(describe),
    titleOnly: all.filter((el) => nameOf(el) && !ownName(el)).map(describe),
    total: all.length,
    iconOnly: all.filter((el) => !(el.innerText || '').trim()).map((el) => `${describe(el)} => "${(el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, 40)}" ${el.getAttribute('aria-label') ? '[aria-label]' : el.getAttribute('title') ? '[title]' : el.getAttribute('aria-labelledby') ? '[labelledby]' : '[other]'}`),
  };
}

const unnamedSeen = new Map();
const titleOnlySeen = new Map();
const iconOnlySeen = new Map();
let checkedTotal = 0;
let unnamedTotal = 0;
const perState = [];
async function crawl(page, label) {
  const { unnamed: found, titleOnly, total, iconOnly } = await page.evaluate(findUnnamed);
  checkedTotal += total;
  for (const line of iconOnly) iconOnlySeen.set(line, label);
  perState.push({ label, count: found.length, examples: found.slice(0, 3) });
  for (const description of found) {
    unnamedTotal += 1;
    if (!unnamedSeen.has(description)) unnamedSeen.set(description, label);
  }
  for (const description of titleOnly) if (!titleOnlySeen.has(description)) titleOnlySeen.set(description, label);
}

const PAGES = ['/files', '/photos', '/recent', '/starred', '/shared', '/trash', '/overview', '/devices', '/export', '/quarantine', '/account', '/emergency-access'];
const SIZES = [{ name: '360', width: 360, height: 800 }, { name: '1366', width: 1366, height: 768 }];

async function postFile(token, name, buffer, folder) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/octet-stream' }), name);
  if (folder) form.append('folder', folder);
  return fetch(`${base}/api/documents`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
}

let browser;
try {
  const email = 'tooltips.check@example.com';
  const password = 'Qx7!vTr29#mLpw';
  await api('POST', '/api/auth/signup/start', { json: { email, password, termsAccepted: true } });
  const code = /(?<![\d-])(\d{6})(?![\d-])/.exec(mails.at(-1).text)[1];
  const token = (await api('POST', '/api/auth/signup/verify', { json: { email, password, code } })).body.sessionToken;
  for (const name of ['Taxes', 'Health records']) await api('POST', '/api/documents/folders', { token, json: { name, parentPath: '', color: 'blue', icon: 'folder' } });
  const ids = [];
  for (const [name, text, folder] of [['report.pdf', '%PDF-1.4\n%%EOF\n', undefined], ['notes.txt', 'some notes', undefined], ['receipt.txt', 'a receipt', 'Taxes']]) {
    const res = await postFile(token, name, Buffer.from(text), folder);
    ids.push((await res.json()).id);
  }
  await postFile(token, 'risky-form.pdf', Buffer.from('%PDF-1.4 /JavaScript\n%%EOF'));
  await api('POST', '/api/documents/star', { token, json: { ids: [ids[0]], starred: true } });
  await api('DELETE', `/api/documents/${ids[1]}`, { token });

  browser = await launch();
  const newContext = async (size, extra = {}) => {
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, reducedMotion: 'no-preference', colorScheme: THEME, ...extra });
    await context.addInitScript((value) => {
      try { window.sessionStorage.setItem('warden.session', value); } catch {  }
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (event) => window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
    }, token);
    return context;
  };
  const consoleProblems = [];

  for (const size of SIZES) {
    const context = await newContext(size);
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('console', (message) => { if (message.type() === 'error') consoleProblems.push(message.text()); });
    const tag = `${size.name}px ${THEME}`;
    const settle = async () => { await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(500); };
    for (const route of PAGES) {
      await page.goto(base + route, { waitUntil: 'domcontentloaded' });
      await settle();
      await crawl(page, `${tag} ${route}`);
      if (size.width < 768) {
        const toggle = page.getByRole('button', { name: 'Open navigation menu' });
        if (await toggle.count()) {
          await toggle.click();
          await page.waitForTimeout(400);
          await crawl(page, `${tag} ${route} (drawer)`);
          await page.keyboard.press('Escape');
        }
      } else {
        const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
        if (await collapse.count()) {
          await collapse.click();
          await page.waitForTimeout(300);
          await crawl(page, `${tag} ${route} (sidebar collapsed)`);
        }
      }
    }

    await page.goto(base + '/files', { waitUntil: 'domcontentloaded' });
    await settle();
    const step = async (label, work) => {
      try { await work(); await page.waitForTimeout(350); await crawl(page, `${tag} ${label}`); } catch (error) { perState.push({ label: `${tag} ${label}`, count: 0, examples: [`(could not open: ${String(error.message).split('\n')[0].slice(0, 90)})`] }); }
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(250);
    };
    await step('upload dialog (2 files)', async () => {
      await page.getByRole('button', { name: 'New' }).click();
      await page.getByRole('menuitem', { name: /Upload file/ }).click();
      await page.getByRole('dialog', { name: 'Upload file' }).locator('input[type=file]').setInputFiles([{ name: 'one.txt', mimeType: 'text/plain', buffer: Buffer.from('1') }, { name: 'two.zip', mimeType: 'application/zip', buffer: Buffer.from('2') }]);
    });
    await step('New menu open', async () => { await page.getByRole('button', { name: 'New' }).click(); });
    await step('new folder dialog', async () => {
      await page.getByRole('button', { name: 'New' }).click();
      await page.getByRole('menuitem', { name: /New folder/ }).click();
    });
    await step('scan dialog', async () => { await page.getByRole('button', { name: /^Scan/ }).first().click(); });
    await step('details panel', async () => { await page.locator('button[aria-label^="Details for"], button[title="Details"]').first().click(); });
    await step('context menu (file)', async () => { await page.getByText('report.pdf').first().click({ button: 'right' }); });
    await step('file selected (selection bar)', async () => { await page.locator('input[type=checkbox][aria-label^="Select "]').first().check(); });
    await step('grid view', async () => { await page.getByRole('button', { name: /grid/i }).first().click(); });
    await step('transfer tray', async () => {
      await page.getByRole('button', { name: 'New' }).click();
      await page.getByRole('menuitem', { name: /Upload file/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Upload file' });
      await dialog.locator('input[type=file]').setInputFiles({ name: 'tray-sample.txt', mimeType: 'text/plain', buffer: Buffer.from('tray') });
      await dialog.getByRole('button', { name: /^Encrypt/ }).click();
      await page.getByTestId('transfer-tray').waitFor();
      await page.getByText(/sealed/i).first().waitFor({ timeout: 10000 });
    });
    await page.goto(base + '/quarantine', { waitUntil: 'domcontentloaded' });
    await settle();
    await step('release dialog', async () => { await page.getByRole('button', { name: /^Release/ }).first().click(); });
    await context.close();
  }

  console.log(`\nUnnamed controls found while crawling: ${unnamedTotal} (${unnamedSeen.size} different ones)`);
  for (const [description, where] of unnamedSeen) console.log(`  ${description}   [first seen: ${where}]`);
  console.log(`Controls looked at: ${checkedTotal}. Named by a title attribute only (no aria-label, no text): ${titleOnlySeen.size} different ones`);
  for (const [description, where] of titleOnlySeen) console.log(`  title-only: ${description}   [first seen: ${where}]`);
  console.log(`Icon-only controls (no text of their own): ${iconOnlySeen.size} different ones`);
  if (process.env.DUMP) for (const [line, where] of iconOnlySeen) console.log(`  icon-only: ${line}   [${where}]`);
  const worst = perState.filter((p) => p.count > 0);
  console.log(`  states with at least one: ${worst.length} of ${perState.length}`);
  for (const p of perState.filter((q) => q.examples[0]?.startsWith('(could not'))) console.log(`  NOT OPENED: ${p.label} ${p.examples[0]}`);
  if (!LIST) check(unnamedSeen.size === 0, `no visible icon-only control is without an accessible name (${unnamedSeen.size} found)`);
  if (LIST) process.exitCode = 0;
  const context = await newContext({ name: '1366', width: 1366, height: 768 });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('console', (message) => { if (message.type() === 'error') consoleProblems.push(message.text()); });
  const tip = page.getByTestId('tooltip');
  const visibleTips = () => page.evaluate(() => [...document.querySelectorAll('[role="tooltip"]')].filter((t) => !t.hidden && getComputedStyle(t).display !== 'none').length);
  const view = { w: 1366, h: 768 };
  const inside = (box) => box && box.x >= 8 - 0.5 && box.y >= 0 && box.x + box.width <= view.w - 8 + 0.5 && box.y + box.height <= view.h;
  async function hoverTip(locator, label, expected, { edge = true } = {}) {
    await page.mouse.move(2, 2);
    await page.waitForTimeout(150);
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.hover();
    const shown = await tip.waitFor({ state: 'visible', timeout: 2500 }).then(() => true, () => false);
    const text = shown ? (await tip.innerText()).trim() : null;
    const box = shown ? await tip.boundingBox() : null;
    check(shown && (expected instanceof RegExp ? expected.test(text) : text === expected), `${label}: the tooltip says "${text}"`);
    if (shown) {
      check((await visibleTips()) === 1, `${label}: only one tooltip is showing`);
      if (edge) check(inside(box), `${label}: it stays inside the screen (${box ? `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}` : ''})`);
      check((await tip.evaluate((el) => getComputedStyle(el).pointerEvents)) === 'none', `${label}: it never takes a click (pointer-events none)`);
      check((await locator.evaluate((el) => el.getAttribute('title'))) === null, `${label}: no native title tooltip is left to show twice`);
    }
    if (SHOTS && shown && ['star', 'Lock vault (near the right edge)', 'tray: the status icon', 'Release before the word matches', 'collapsed sidebar: Account'].includes(label)) await page.screenshot({ path: path.join(SHOTS, `tooltip-${label.replace(/[^a-z]+/gi, '-').toLowerCase()}-${THEME}.png`) });
    return text;
  }
  const goto = async (route) => { await page.goto(base + route, { waitUntil: 'domcontentloaded' }); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(400); };

  await goto('/files');
  await hoverTip(page.locator('button[aria-label^="Star "], button[aria-label^="Remove star "]').first(), 'star', /^(Star|Remove star) /);
  await hoverTip(page.locator('button[aria-label^="Details for "]').first(), 'details', /^Details for /);
  await hoverTip(page.locator('button[aria-label^="More actions for "]').first(), 'three dots', /^More actions for /);
  await hoverTip(page.getByRole('button', { name: 'Collapse folders' }), 'chevron', 'Collapse folders');
  await hoverTip(page.getByRole('button', { name: 'Lock vault' }), 'Lock vault (near the right edge)', 'Lock now and require your password again');
  await hoverTip(page.getByRole('button', { name: /^Scan/ }).first(), 'Scan', 'Scan a paper document with the camera into a PDF');
  await hoverTip(page.getByRole('button', { name: 'List view' }), 'List view', 'List view');
  await page.mouse.move(2, 2);
  await page.getByRole('button', { name: 'New' }).hover();
  await page.waitForTimeout(700);
  check((await visibleTips()) === 0, 'a button with visible text and no data-tip (New) shows no tooltip');
  await hoverTip(page.locator('button[aria-label^="Details for "]').first(), 'neighbour 1', /^Details for /);
  const startedSwitch = Date.now();
  await page.locator('button[aria-label^="More actions for "]').first().hover();
  await tip.filter({ hasText: /^More actions/ }).waitFor({ state: 'visible', timeout: 1500 });
  check(Date.now() - startedSwitch < 350 && (await visibleTips()) === 1, `moving to a neighbour shows its tooltip at once (${Date.now() - startedSwitch} ms), still only one`);
  await page.locator('button[aria-label^="Star "], button[aria-label^="Remove star "]').first().hover();
  await tip.waitFor({ state: 'visible' });
  const starName = await page.locator('button[aria-label^="Star "], button[aria-label^="Remove star "]').first().getAttribute('aria-label');
  await page.locator('button[aria-label^="Star "], button[aria-label^="Remove star "]').first().click();
  await page.waitForTimeout(300);
  check((await visibleTips()) === 0, 'a click hides the tooltip');
  check((await page.locator(`button[aria-label^="${starName.startsWith('Star') ? 'Remove star' : 'Star'} "]`).count()) >= 1, 'and the click went through to the button');
  await hoverTip(page.locator('button[aria-label^="Details for "]').first(), 'for Escape', /^Details for /);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  check((await visibleTips()) === 0, 'Escape hides it');

  await page.mouse.move(2, 2);
  await page.getByRole('button', { name: 'Grid view' }).focus();
  await tip.waitFor({ state: 'visible', timeout: 1000 });
  check((await tip.innerText()).trim() === 'Grid view', 'keyboard focus shows the tooltip at once ("Grid view")');
  await page.getByRole('button', { name: 'Grid view' }).blur();
  await page.waitForTimeout(100);
  check((await visibleTips()) === 0, 'and blur hides it');

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await page.waitForTimeout(300);
  for (const [href, text] of [['/photos', 'Photos'], ['/quarantine', 'Quarantine'], ['/account', 'Account']]) await hoverTip(page.locator(`#app-sidebar a[href="${href}"]`), `collapsed sidebar: ${text}`, text);
  await hoverTip(page.getByRole('button', { name: 'Expand sidebar' }), 'Expand sidebar', 'Expand sidebar');
  await page.getByRole('button', { name: 'Expand sidebar' }).click();

  await page.getByRole('button', { name: 'New' }).click();
  await page.getByRole('menuitem', { name: /Upload file/ }).click();
  const uploadDialog = page.getByRole('dialog', { name: 'Upload file' });
  await uploadDialog.waitFor();
  await hoverTip(uploadDialog.getByRole('button', { name: 'Close' }), 'the close X of a dialog', 'Close');
  await hoverTip(uploadDialog.getByRole('button', { name: /^Encrypt/ }), 'Encrypt & upload with no files (aria-disabled)', 'Choose at least one file');
  await uploadDialog.locator('input[type=file]').setInputFiles({ name: 'tip-sample.txt', mimeType: 'text/plain', buffer: Buffer.from('tip') });
  await page.waitForTimeout(200);
  await hoverTip(uploadDialog.getByRole('button', { name: /^Encrypt/ }), 'Encrypt & upload with a file', 'Encrypt the files and save them to your vault');
  await hoverTip(uploadDialog.getByRole('button', { name: 'Remove tip-sample.txt' }), 'Remove file in the list', 'Remove tip-sample.txt');
  const z = await tip.evaluate((el) => Number(getComputedStyle(el).zIndex));
  check(z >= 2000, `the tooltip is above the dialog (z-index ${z})`);
  await uploadDialog.getByRole('button', { name: /^Encrypt/ }).click();
  await uploadDialog.waitFor({ state: 'detached', timeout: 5000 });

  await page.getByTestId('transfer-tray').waitFor();
  await page.getByText(/sealed|Held/i).first().waitFor({ timeout: 10000 });
  await hoverTip(page.getByRole('button', { name: 'Minimize the transfers' }), 'tray: minimize', 'Minimize the transfers');
  await hoverTip(page.getByRole('button', { name: 'Close the transfers' }), 'tray: close (bottom-right corner area)', 'Close the transfers');
  await hoverTip(page.getByTestId('status-icon').first(), 'tray: the status icon', /^Sealed: encrypted with your vault key/);
  await page.getByRole('button', { name: 'Close the transfers' }).click();

  await goto('/export');
  await hoverTip(page.getByRole('button', { name: 'Import', exact: true }), 'Import with no zip chosen', 'Choose a .zip first');
  await hoverTip(page.getByRole('button', { name: /^Download all my files/ }), 'Download all my files (.zip)', 'The zip is not encrypted');

  await goto('/quarantine');
  await hoverTip(page.getByRole('button', { name: /^Release / }).first(), 'Release', 'Move this file out of quarantine');
  await page.getByRole('button', { name: /^Release / }).first().click();
  const releaseDialog = page.getByRole('dialog', { name: 'Release this file?' });
  await releaseDialog.waitFor();
  await hoverTip(releaseDialog.getByRole('button', { name: 'Release file' }), 'Release before the word matches', 'Type RELEASE to enable');
  await page.keyboard.press('Escape');

  const phone = await newContext({ name: '360', width: 360, height: 800 }, { hasTouch: true, isMobile: true });
  const mobile = await phone.newPage();
  await mobile.goto(`${base}/files`, { waitUntil: 'domcontentloaded' });
  await mobile.waitForLoadState('networkidle').catch(() => {});
  const star = mobile.locator('button[aria-label^="Star "], button[aria-label^="Remove star "]').first();
  await star.tap();
  await mobile.waitForTimeout(900);
  check((await mobile.evaluate(() => [...document.querySelectorAll('[role="tooltip"]')].filter((t) => !t.hidden).length)) === 0, 'a tap on a touch screen shows no hover tooltip');
  await phone.close();

  const csp = await page.evaluate(() => window.__csp);
  check(csp.length === 0, `no CSP violations (${csp.join('; ') || 'none'})`);
  const bad = consoleProblems.filter((line) => /content security policy|refused to|violat/i.test(line));
  check(bad.length === 0, `no CSP errors in the console${bad.length ? `: ${bad.join(' | ')}` : ''}`);
  await context.close();
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
