import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import zlib from 'node:zlib';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const dist = process.env.DIST_DIR ? path.resolve(process.env.DIST_DIR) : path.join(root, 'client', 'dist');
const requireServer = createRequire(path.join(root, 'server', 'package.json'));
const SHOTS = process.env.SHOTS || '';
const TRAY_MS = 3000;

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-quarantine-'));

const pdfWith = (marker) => Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R ${marker} >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`);
const riskyPdf = () => pdfWith('/JavaScript');
const testSignature = () => Buffer.from(['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-', 'ANTIVIRUS-TEST-FILE!', '$H+H*'].join(''));
const sample = (name, buffer, mimeType = 'application/octet-stream') => ({ name, mimeType, buffer });
function zipOf(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}


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
    try { window.sessionStorage.setItem('warden.session', value); } catch {  }
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

  await uploadVia(sample('clean-note.txt', Buffer.from('an ordinary note')));
  await rows.first().getByText(/^Sealed · checked$/).waitFor({ timeout: 10000 });
  const sealedRingHtml = await rows.first().getByTestId('status-icon').innerHTML();
  const icon = rows.first().getByTestId('status-icon');
  const tipBox = page.getByTestId('tooltip');
  await icon.hover();
  await page.waitForTimeout(100);
  check(!(await tipBox.isVisible()), 'the tooltip is not there before the 400 ms of resting');
  await tipBox.waitFor({ timeout: 2000 });
  check(/^Sealed: encrypted with your vault key and saved\. Warden's simple rules found nothing risky\. This is not a full antivirus\.$/.test(await tipBox.innerText()), 'hovering a sealed row\'s lock shows what Sealed means');
  const tipRect = await tipBox.boundingBox();
  check(tipRect.x >= 0 && tipRect.x + tipRect.width <= 1280 && tipRect.y >= 0 && tipRect.y + tipRect.height <= 860, 'and it stays inside the screen');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'tooltip-sealed-1280.png') });
  await page.mouse.move(10, 10);
  await tipBox.waitFor({ state: 'hidden', timeout: 2000 });
  check(true, 'it hides when the mouse leaves');
  await page.keyboard.press('Shift');
  await icon.focus();
  await tipBox.waitFor({ timeout: 2000 });
  check(/Sealed: encrypted/.test(await tipBox.innerText()), 'keyboard focus shows it too');
  check((await tipBox.getAttribute('role')) === 'tooltip', 'it is a role="tooltip" element');
  check(/Sealed: encrypted/.test((await icon.getAttribute('aria-label')) || ''), 'the icon has an accessible name with the same words');
  await page.keyboard.press('Escape');
  await tipBox.waitFor({ state: 'hidden', timeout: 2000 });
  check((await tray.getAttribute('data-minimized')) !== 'true', 'Escape hides the tooltip (and does not also minimize the tray)');
  check(/· checked/.test(await rows.first().innerText()), 'the row says "Sealed · checked", so the lock is not the only message');
  check(/1 file sealed/.test(await page.getByTestId('tray-title').innerText()), 'a clean file is sealed as before ("1 file sealed")');
  check((await docs()).some((d) => d.filename === 'clean-note.txt'), 'and it is in the vault');
  check((await heldList()).count === 0, 'nothing is held');
  await closeTray();

  await uploadVia(sample('tax-form.pdf', riskyPdf(), 'application/pdf'));
  await rows.first().getByText(/Held for review/).waitFor({ timeout: 10000 });
  check(/Held for review: PDF with active content/.test(await rows.first().innerText()), 'the tray row says "Held for review: PDF with active content"');
  check((await rows.first().getAttribute('data-ring')) === 'held', 'with the amber held ring');
  check(/held for review/.test(await page.getByTestId('tray-title').innerText()), 'the tray title says so');
  check((await rows.first().getByRole('button', { name: /^Open Quarantine/ }).count()) === 1, 'and offers a way to Quarantine');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'quarantine-tray-held-1280.png') });
  const heldIcon = rows.first().getByTestId('status-icon');
  await heldIcon.hover();
  await page.getByTestId('tooltip').waitFor({ timeout: 2000 });
  const heldTip = await page.getByTestId('tooltip').innerText();
  check(/^Held for review: Warden's rules found something risky\. Reasons: This PDF contains active content/.test(heldTip) && /Open Quarantine to decide\.$/.test(heldTip), 'a held row\'s tooltip gives the reasons in plain sentences');
  check(!/PDF_ACTIVE/.test(heldTip), 'never the raw code');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'tooltip-held-1280.png') });
  await page.mouse.move(10, 10);

  await page.waitForTimeout(TRAY_MS + 1000);
  check(await tray.isVisible(), 'a held file keeps the tray open (it needs a decision)');
  const badge = page.getByTestId('quarantine-badge');
  await page.waitForTimeout(300);
  check((await badge.count()) === 1 && (await badge.innerText()).trim() === '1', 'the sidebar item shows a badge with 1');
  if (SHOTS) {
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

  await nav('Recent').click();
  await page.waitForURL((url) => url.pathname === '/recent');
  await page.waitForTimeout(800);
  check((await page.getByText('tax-form.pdf').count()) === 0, 'it is not in Recent');
  await nav('Photos').click();
  await page.waitForURL((url) => url.pathname === '/photos');
  check((await page.getByText('tax-form.pdf').count()) === 0, 'it is not in Photos');

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

  const held1 = (await heldList()).items[0];
  const viewResponse = await fetch(`${base}/api/documents/${held1.id}/view`, { headers: { authorization: `Bearer ${token}` } });
  const viewBody = await viewResponse.text();
  check(viewResponse.status === 409 && /QUARANTINED/.test(viewBody) && !/JavaScript/.test(viewBody), 'preview / download answer 409 QUARANTINED and send no content');
  const shareResponse = await api('POST', `/api/documents/${held1.id}/share`, { token, json: { durationHours: 24 } });
  check(shareResponse.status === 409, 'a share link cannot be made for it');

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
  await page.locator('button[aria-label^="Details for tax-form"]').first().click();
  const panel = page.getByRole('dialog', { name: /^Details for/ });
  await panel.waitFor();
  await panel.getByText('Scan', { exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
  check(/Released after review/.test(await panel.innerText()), 'Details says "Released after review"');
  await page.keyboard.press('Escape');

  const before = await countAll();
  await uploadVia(sample('notes.txt', testSignature()));
  await rows.first().getByText(/Not saved/).waitFor({ timeout: 10000 });
  check(/Not saved: antivirus test file/.test(await rows.first().innerText()), 'the tray row says "Not saved: antivirus test file"');
  check((await rows.first().getAttribute('data-ring')) === 'refused', 'with the red ring');
  check((await rows.first().getByRole('button', { name: /^Retry/ }).count()) === 0, 'and no Retry');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'quarantine-tray-refused-1280.png') });
  await rows.first().getByTestId('status-icon').hover();
  await page.getByTestId('tooltip').waitFor({ timeout: 2000 });
  check(/^Not saved: This file carries the standard antivirus test signature\.$/.test(await page.getByTestId('tooltip').innerText()), 'a not-saved row\'s tooltip gives the server\'s sentence');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'tooltip-refused-1280.png') });
  await page.mouse.move(10, 10);

  check((await countAll()) === before, 'nothing was stored');
  check(!(await docs()).some((d) => d.filename === 'notes.txt') && (await heldList()).count === 0, 'it is in no list and not in Quarantine');
  await closeTray();

  const openUploadDialog = async () => {
    await page.getByRole('button', { name: 'New' }).click();
    await page.getByRole('menuitem', { name: /Upload file/ }).click();
    const opened = page.getByRole('dialog', { name: 'Upload file' });
    await opened.waitFor();
    return opened;
  };
  const zipDialog = await openUploadDialog();
  await zipDialog.locator('input[type=file]').setInputFiles([sample('archive.zip', zipOf({ 'a.txt': 'hello' })), sample('plain.txt', Buffer.from('fine'))]);
  const zipRow = zipDialog.locator('[data-testid="upload-row"][data-error="true"]');
  await zipRow.waitFor({ timeout: 3000 });
  check(/Zips go through Export \/ Import/.test(await zipRow.innerText()), 'a .zip in the dialog gets the row error "Zips go through Export / Import"');
  check((await zipRow.getByRole('button', { name: 'Open Export / Import' }).count()) === 1, 'with an "Open Export / Import" button');
  check(await zipDialog.getByRole('button', { name: /^Encrypt & upload$/ }).isEnabled(), 'the other file is not blocked');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'upload-zip-row-1280.png') });
  await zipRow.getByRole('button', { name: 'Open Export / Import' }).click();
  await page.waitForURL((url) => url.pathname === '/export', { timeout: 5000 });
  check(true, 'the button opens Export / Import (and closes the dialog)');
  await page.goto(`${base}/files`);
  await page.getByRole('button', { name: 'New' }).waitFor({ timeout: 15000 });
  const beforeZip = await countAll();
  await uploadVia(sample('archive.bin', zipOf({ 'a.txt': 'hello', 'b.txt': 'world' })));
  await rows.first().getByText(/Not saved/).waitFor({ timeout: 10000 });
  await rows.first().getByTestId('status-icon').hover();
  await page.getByTestId('tooltip').waitFor({ timeout: 2000 });
  check(/^Not saved: Zip files go through Export \/ Import, so every file inside is checked\.$/.test(await page.getByTestId('tooltip').innerText()), 'a renamed zip is refused by the server: "Not saved" with its sentence');
  check((await countAll()) === beforeZip, 'nothing was stored');
  await page.mouse.move(10, 10);
  await closeTray();
  const docx = zipOf({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>' });
  await uploadVia(sample('letter.docx', docx));
  await rows.first().getByText(/^Sealed · checked$/).waitFor({ timeout: 10000 });
  check((await docs()).some((d) => d.filename === 'letter.docx'), 'a docx built at run time uploads and is sealed');
  await closeTray();

  await nav('Export / Import').click();
  await page.waitForURL((url) => url.pathname === '/export');
  await page.locator('input[aria-label="Choose a .zip to import"]').setInputFiles(sample('mix.zip', zipOf({
    'Mix/clean.txt': 'plain words',
    'Mix/form-1.pdf': '%PDF-1.4 /JavaScript',
    'Mix/form-2.pdf': '%PDF-1.4 /OpenAction',
    'Mix/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>',
  })));
  await page.getByRole('button', { name: /^Import 4 files$/ }).click();
  await tray.waitFor({ timeout: 10000 });
  await page.getByTestId('import-report').waitFor({ timeout: 30000 });
  await rows.first().getByText(/each file checked/).waitFor({ timeout: 10000 });
  const importLine = (await rows.first().innerText()).replace(/\s+/g, ' ');
  check(/Imported 1 file, 3 held for review · each file checked/.test(importLine), `the tray row says "Imported 1 file, 3 held for review" (${importLine.slice(0, 90)})`);
  check(!/Imported 4|4 files imported|3 skipped/.test(importLine), 'and never counts the held files as imported or skipped');
  check(/Sealed 1, 3 held for review/.test(await page.getByTestId('tray-title').innerText()), 'the tray title says "Sealed 1, 3 held for review"');
  const reportText = (await page.getByTestId('import-report').innerText()).replace(/\s+/g, ' ');
  check(/Imported 1 file, 3 held for review\./.test(reportText) && !/4 files imported/.test(reportText), 'the Import page report says the same');
  check((await rows.first().getAttribute('data-ring')) === 'held', 'the import row is amber (held), not the sealed lock');
  check((await rows.first().getByTestId('status-icon').innerHTML()) !== sealedRingHtml, 'with a different icon shape from a sealed row');
  check((await tray.getAttribute('data-state')) === 'held', 'the tray is in its held state');
  check((await rows.first().getByRole('button', { name: 'Review held files' }).count()) === 1, 'the finished row has "Review held files"');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'import-held-tray-1280.png') });
  await tray.getByRole('button', { name: 'Minimize the transfers' }).click();
  check((await tray.locator('header [data-ring]').first().getAttribute('data-ring')) === 'held', 'the minimized tray ring is amber');
  await tray.getByRole('button', { name: 'Expand the transfers' }).click();
  await rows.first().getByRole('button', { name: 'Review held files' }).click();
  await page.waitForURL((url) => url.pathname === '/quarantine', { timeout: 5000 });
  check((await heldList()).count >= 3, 'the button opens Quarantine with the held files');
  await closeTray();
  await page.goto(`${base}/files`);
  await page.getByRole('button', { name: 'New' }).waitFor({ timeout: 15000 });

  const phone = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  await phone.addInitScript((value) => { try { window.sessionStorage.setItem('warden.session', value); } catch {  } }, token);
  const mobile = await phone.newPage();
  await mobile.goto(`${base}/files`);
  await mobile.getByRole('button', { name: 'New' }).waitFor({ timeout: 15000 });
  await mobile.getByRole('button', { name: 'New' }).tap();
  await mobile.getByRole('menuitem', { name: /Upload file/ }).tap();
  const mDialog = mobile.getByRole('dialog', { name: 'Upload file' });
  await mDialog.locator('input[type=file]').setInputFiles(sample('phone-note.txt', Buffer.from('from a phone')));
  await mDialog.getByRole('button', { name: /^Encrypt/ }).tap();
  const mRow = mobile.getByTestId('transfer-row').first();
  await mRow.getByText(/^Sealed · checked$/).waitFor({ timeout: 10000 });
  await mRow.getByTestId('status-icon').tap();
  const mTip = mobile.getByTestId('tooltip');
  await mTip.waitFor({ timeout: 2000 });
  const mBox = await mTip.boundingBox();
  check(/Sealed: encrypted/.test(await mTip.innerText()), 'a tap on the icon opens the popover');
  check(mBox.x >= 0 && mBox.x + mBox.width <= 360 && mBox.y >= 0, `and it fits at 360 px (${Math.round(mBox.x)}..${Math.round(mBox.x + mBox.width)})`);
  if (SHOTS) await mobile.screenshot({ path: path.join(SHOTS, 'tooltip-touch-360.png') });
  await mobile.touchscreen.tap(180, 300);
  await mTip.waitFor({ state: 'hidden', timeout: 2000 });
  check(true, 'a tap elsewhere closes it');
  await phone.close();

  const scanner = requireServer('./utils/fileScanner');
  const real = scanner.scanBuffer;
  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(3.5 * 1024 * 1024, 0x41), Buffer.from('\n%%EOF')]);
  const timesReal = [];
  const timesOff = [];
  for (let n = 0; n < 10; n += 1) {
    scanner.scanBuffer = real;
    timesReal.push((await postFile(token, `speed-a-${n}.pdf`, big)).ms);
    scanner.scanBuffer = () => ({ verdict: 'clean', reasons: [], score: 0, version: 1 });
    timesOff.push((await postFile(token, `speed-b-${n}.pdf`, big)).ms);
  }
  scanner.scanBuffer = real;
  const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
  const scanMs = (() => { const t = process.hrtime.bigint(); real({ name: 'x.pdf', type: '', buffer: big }); return Number(process.hrtime.bigint() - t) / 1e6; })();
  console.log(`upload of 3.5 MB (median of 10): with the scan ${median(timesReal).toFixed(0)} ms, scan switched off ${median(timesOff).toFixed(0)} ms; the scan alone ${scanMs.toFixed(1)} ms`);
  check(median(timesReal) - median(timesOff) < 50, `the scan adds under 50 ms to a 3.5 MB upload (${(median(timesReal) - median(timesOff)).toFixed(1)} ms)`);

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
