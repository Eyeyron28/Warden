// node scripts/check-logout.mjs   (from client, after "npm run build"; DIST_DIR=<another build> to try another one)
//
// Signs in and out through the real login page in a real browser, against the real app on a LOCAL throwaway MongoDB (127.0.0.1:27099,
// or a local WARDEN_TEST_MONGO; no .env is read; mail is captured), served with the production CSP. For each signed-in page it signs
// in, opens the page, signs out, signs in again and expects to land on My Files - also after closing and reopening the tab, and with a
// different account in the same browser. It checks that Back after sign-out shows no account data, that a session the server ends
// returns the SAME account to an ordinary page only (never Devices, Settings, Import or Emergency Access), and that there are no CSP
// violations.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

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
const uri = baseUri.replace(/^(mongodb:\/\/[^/]+)\/[^?]*/, '$1/warden_logout_check');

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
Object.assign(process.env, { NODE_ENV: 'test', MONGO_URI: uri, SIGNUP_MODE: 'open', OTP_ENABLED: 'false', PUBLIC_APP_URL: 'https://warden.test', EMERGENCY_DEMO_MODE: 'false', STORAGE_QUOTA_MB: '200', CORS_ORIGINS: 'http://127.0.0.1:5064' });
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
await new Promise((resolve) => server.listen(5064, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:5064';

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


const PAGES = [
  ['Files', '/files'],
  ['Starred', '/starred'],
  ['Recent', '/recent'],
  ['Shared', '/shared'],
  ['Trash', '/trash'],
  ['Overview', '/overview'],
  ['Devices', '/devices'],
  ['Settings', '/account'],
  ['Import', '/export'],
  ['Emergency Access', '/emergency-access'],
];
const PASSWORD = 'Qx7!vTr29#mLpw';
const A = 'logout.a@example.com';
const B = 'logout.b@example.com';

async function makeAccount(email) {
  await api('POST', '/api/auth/signup/start', { json: { email, password: PASSWORD, termsAccepted: true } });
  const code = /(?<![\d-])(\d{6})(?![\d-])/.exec(mails.filter((m) => m.to === email).at(-1).text)[1];
  return (await api('POST', '/api/auth/signup/verify', { json: { email, password: PASSWORD, code } })).body.sessionToken;
}

let browser;
try {
  await makeAccount(A);
  await makeAccount(B);
  browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
  });
  const consoleErrors = [];
  const open = async () => {
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    return page;
  };
  const where = (page) => new URL(page.url());
  const landedOnFiles = (page) => where(page).pathname === '/files' && where(page).search === '';
  const text = (page) => page.evaluate(() => document.body.innerText);

  async function fillAndSubmit(page, email) {
    await mongoose.models.RateLimit.deleteMany({}); // a long run of sign-ins would otherwise meet the login rate limit
    await page.getByLabel(/^email/i).fill(email);
    await page.locator('input[type=password]').first().fill(PASSWORD);
    await page.getByRole('button', { name: /^continue$/i }).first().click();
    await page.waitForFunction(() => !location.pathname.startsWith('/login'), null, { timeout: 15000 });
    await page.waitForTimeout(500);
  }
  async function signIn(page, email) {
    await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
    await fillAndSubmit(page, email);
  }
  async function lockVault(page) {
    await page.getByRole('button', { name: 'Lock vault' }).click();
    await page.waitForURL((url) => url.pathname === '/login', { timeout: 10000 });
  }

  // ---- every page: sign in, open it, sign out, sign in again -> My Files ----
  const page = await open();
  await signIn(page, A);
  check(landedOnFiles(page), `a first sign-in lands on My Files (${where(page).pathname})`);
  for (const [name, route] of PAGES) {
    await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((r) => location.pathname === r, route);
    await page.waitForTimeout(500);
    await lockVault(page);
    check(where(page).pathname === '/login', `${name}: after signing out the address bar shows /login, not ${route}`);
    const remembered = await page.evaluate(() => ({ from: history.state?.usr?.from ?? null, session: Object.keys(sessionStorage), local: Object.keys(localStorage).filter((key) => !/theme/i.test(key)) }));
    check(remembered.from === null && remembered.session.length === 0 && remembered.local.length === 0, `${name}: no remembered page in the history entry and nothing in storage (${JSON.stringify(remembered)})`);
    await signIn(page, A);
    check(landedOnFiles(page), `${name}: signing in again lands on My Files (${where(page).pathname}${where(page).search})`);
  }

  // ---- closing the tab while on a page, then opening it again ----
  let current = page;
  for (const [name, route] of [['Devices', '/devices'], ['Import', '/export'], ['Emergency Access', '/emergency-access'], ['Trash', '/trash']]) {
    await current.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
    await current.waitForTimeout(400);
    await current.close();
    current = await open();
    await current.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
    await current.waitForURL((url) => url.pathname === '/login', { timeout: 10000 });
    await fillAndSubmit(current, A);
    check(landedOnFiles(current), `${name}: after closing the tab on ${route} and opening it again, signing in lands on My Files (${where(current).pathname})`);
  }
  const tab = current;

  // ---- a different account in the same browser ----
  await tab.goto(`${base}/devices`, { waitUntil: 'domcontentloaded' });
  await tab.waitForTimeout(400);
  await lockVault(tab);
  await signIn(tab, B);
  check(landedOnFiles(tab), `account B, after A signed out on Devices, lands on My Files (${where(tab).pathname})`);
  await tab.goto(`${base}/trash`, { waitUntil: 'domcontentloaded' });
  await tab.waitForTimeout(400);
  await lockVault(tab);
  await signIn(tab, A);
  check(landedOnFiles(tab), `and A again lands on My Files, not B's last page (${where(tab).pathname})`);

  // ---- Back after sign-out shows no account data ----
  await tab.goto(`${base}/overview`, { waitUntil: 'networkidle' });
  check(/Lock vault/.test(await text(tab)), 'the signed-in page shows the account controls (so the next check means something)');
  await lockVault(tab);
  await tab.goBack();
  await tab.waitForTimeout(800);
  const afterBack = { path: where(tab).pathname, text: await text(tab) };
  check(afterBack.path === '/login', `Back after sign-out shows the sign-in page (${afterBack.path})`);
  check(!afterBack.text.includes(A) && !/Lock vault|Overview|Starred|Trash|Devices & activity/.test(afterBack.text), 'and no account data: no navigation, no Lock vault button, no address');
  await tab.goBack().catch(() => {});
  await tab.waitForTimeout(500);
  await tab.goForward().catch(() => {});
  await tab.waitForTimeout(500);
  check(!/Lock vault|Devices & activity/.test(await text(tab)), `Back and Forward again still show no account data (${where(tab).pathname})`);
  await tab.reload();
  check(where(tab).pathname === '/login', 'reloading after sign-out shows the sign-in page');

  // ---- a session the SERVER ends: the same account returns to an ordinary page only ----
  const endSessions = async () => { await mongoose.models.Session.deleteMany({}); };
  const link = (name) => tab.getByRole('link', { name, exact: true }).first();
  await signIn(tab, A);
  await link('Trash').click();
  await tab.waitForURL((url) => url.pathname === '/trash');
  await tab.waitForTimeout(500);
  await endSessions();
  await link('Shared').click();
  await tab.waitForURL((url) => url.pathname === '/login', { timeout: 10000 });
  check(/session expired/i.test(await text(tab)), 'a session the server ended says so on the sign-in page');
  await fillAndSubmit(tab, A);
  check(where(tab).pathname === '/shared', `the SAME account signing in after that expiry returns to the ordinary page it was on (${where(tab).pathname})`);

  await link('Devices & activity').click();
  await tab.waitForURL((url) => url.pathname === '/devices');
  await tab.waitForTimeout(500);
  await endSessions();
  await link('Overview').click();
  await tab.waitForURL((url) => url.pathname === '/login', { timeout: 10000 });
  await fillAndSubmit(tab, A);
  check(where(tab).pathname !== '/devices', `an expiry on Devices is never restored (${where(tab).pathname})`);
  check(['/overview', '/files'].includes(where(tab).pathname), `it lands on My Files, or on the ordinary page the person was moving to (${where(tab).pathname})`);

  await link('Starred').click();
  await tab.waitForURL((url) => url.pathname === '/starred');
  await tab.waitForTimeout(400);
  await endSessions();
  await link('Recent').click();
  await tab.waitForURL((url) => url.pathname === '/login', { timeout: 10000 });
  await fillAndSubmit(tab, B);
  check(landedOnFiles(tab), `a DIFFERENT account signing in after A's expiry lands on My Files (${where(tab).pathname})`);

  const csp = await tab.evaluate(() => window.__csp);
  check(csp.length === 0, `no CSP violations (${csp.join('; ') || 'none'})`);
  const bad = consoleErrors.filter((line) => /content security policy|refused to|violat/i.test(line));
  check(bad.length === 0, `no CSP errors in the console${bad.length ? `: ${bad.join(' | ')}` : ''}`);
} catch (error) {
  console.error(error);
  problems.push(`script error: ${error.message}`);
} finally {
  await browser?.close();
  server.close();
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect().catch(() => {});
}
console.log(problems.length ? `\n${problems.length} problem(s).` : '\nAll checks passed.');
process.exit(problems.length ? 1 : 0);
