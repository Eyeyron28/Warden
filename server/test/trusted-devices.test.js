// Run with: cd server && npm test   (Node's built-in test runner, no deps)
//
// "Trust this browser": after a correct emailed code the owner can skip the code - never the password -
// on that browser for 30 days. In-memory fakes, with a small browser that keeps cookies like a real one.
//
// The regression that started this file (Prompt 26D, part 1): trust was ONE cookie per browser, so trusting
// the browser for a second account overwrote the first account's cookie and the first account was asked for
// an emailed code again. Verified in a real browser first (see the report); here it is a test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

delete process.env.OTP_ENABLED;
delete process.env.VERCEL;
process.env.NODE_ENV = 'test';

const cryptoUtils = require('../utils/crypto');
const db = require('./helpers/fakeDb');

const world = db.createWorld();
db.installModels(world);
const budgets = db.installRateLimit();
db.installMailer(world);

const auth = require('../controllers/auth.controller');
const account = require('../controllers/account.controller');
const security = require('../controllers/security.controller');
const { destroyAllSessionsForUser } = require('../utils/sessionStore');
const { deleteAccountData } = require('../utils/accountDeletion');
const trusted = require('../utils/trustedDevice');
const { call } = db;

const PASSWORD = 'Tk9$Lantern-Orbit%57';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const UA_UPDATED = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/199.0 Safari/537.36';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0';
const DAY = 24 * 3600 * 1000;

function addUser(email, { verified = true } = {}) {
  const salt = cryptoUtils.generateSalt();
  const dek = cryptoUtils.generateDEK();
  const wrapped = cryptoUtils.wrapKey(dek, cryptoUtils.deriveEncryptionKey(PASSWORD, salt));
  const user = {
    _id: db.oid(), email, emailVerified: verified, salt, passwordHash: cryptoUtils.hashPassword(PASSWORD, salt),
    wrappedDEKPassword: wrapped.wrappedKey, wrappedDEKPasswordIv: wrapped.iv, wrappedDEKPasswordAuthTag: wrapped.authTag,
    failedAttempts: 0, save: async () => {},
  };
  world.tables.users.push(user);
  return user;
}
function reset() {
  for (const name of Object.keys(world.tables)) world.tables[name] = [];
  world.mails = [];
}
const lastCode = () => /^(\d{6})$/m.exec(world.mails.at(-1).text)[1];

/** A browser: keeps the cookies the server sets (and drops the ones it clears), sends them back on every request. */
class Browser {
  constructor(userAgent = UA, ip = '203.0.113.9') {
    this.jar = new Map();
    this.userAgent = userAgent;
    this.ip = ip;
  }

  headers() {
    const cookie = [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
    return { 'user-agent': this.userAgent, ...(cookie ? { cookie } : {}) };
  }

  absorb(result) {
    for (const [name, cookie] of Object.entries(result.cookies || {})) this.jar.set(name, cookie.value);
    for (const name of result.cleared || []) this.jar.delete(name);
    return result;
  }

  async send(handler, options = {}) {
    return this.absorb(await call(handler, { ...options, headers: { ...this.headers(), ...(options.headers || {}) }, ip: this.ip }));
  }

  /** Password, then (unless trusted) the emailed code. Returns what the server did. */
  async signIn(user, { trust, password = PASSWORD } = {}) {
    budgets.clear(); // each sign-in stands for a separate hour of use
    const mailsBefore = world.mails.length;
    const first = await this.send(auth.unlock, { body: { email: user.email, password } });
    if (first.error || first.json.sessionToken) return { first, askedForCode: false, mails: world.mails.length - mailsBefore, token: first.json?.sessionToken };
    const second = await this.send(auth.verifyOtp, { body: { challengeToken: first.json.challengeToken, code: lastCode(), trustDevice: trust } });
    return { first, second, askedForCode: true, mails: world.mails.length - mailsBefore, token: second.json?.sessionToken };
  }

  trustCookies() {
    return [...this.jar.keys()].filter((name) => name.startsWith(trusted.COOKIE_PREFIX));
  }
}

const subjects = (since = 0) => world.mails.slice(since).map((m) => m.subject);

// ---------- the cookie itself ----------

test('ticking the box sets a hardened cookie named for the account, and stores only a hash', async () => {
  reset();
  const ana = addUser('ana@example.com');
  const browser = new Browser();
  const { second } = await browser.signIn(ana, { trust: true });
  assert.ok(second.json.sessionToken);
  const name = trusted.cookieNameFor(ana._id);
  assert.match(name, /^warden_td_[0-9a-f]{16}$/);
  const cookie = second.cookies[name];
  assert.ok(cookie, 'cookie issued under the account\'s own name');
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'strict');
  assert.equal(cookie.secure, true);
  assert.equal(cookie.path, '/api');
  assert.equal(cookie.maxAge, 30 * DAY, 'a persistent cookie (Max-Age), not a session cookie');
  assert.equal(world.tables.trusteddevices.length, 1);
  const [row] = world.tables.trusteddevices;
  assert.equal(row.tokenHash, trusted.hashToken(cookie.value));
  assert.ok(Math.abs(row.expiresAt - (Date.now() + 30 * DAY)) < 5000);
  assert.equal(row.label, 'Chrome on Windows');
  assert.ok(!JSON.stringify(world.tables).includes(cookie.value), 'the raw token is stored nowhere');
  assert.ok(!Object.keys(row).some((k) => /ip/i.test(k)), 'no IP stored');
  assert.ok(!name.includes(String(ana._id)), 'the cookie name does not reveal the account id');
  // the browser is also known as a device, and that device is the trusted one
  assert.equal(world.tables.devices.length, 1);
  assert.equal(world.tables.devices[0].trusted, true);
  assert.equal(String(row.deviceId), String(world.tables.devices[0]._id));
});

test('only an explicit true trusts the browser; unticked asks for a code every time', async () => {
  reset();
  const ana = addUser('ana@example.com');
  for (const value of [undefined, false, 'true', 1, 'yes']) {
    const browser = new Browser();
    const { second } = await browser.signIn(ana, { trust: value });
    assert.deepEqual(browser.trustCookies(), [], `trust=${String(value)} sets no trust cookie`);
    assert.ok(second.json.sessionToken);
  }
  assert.equal(world.tables.trusteddevices.length, 0);
});

test('a trusted browser skips the code, but never the password', async () => {
  reset();
  const ana = addUser('ana@example.com');
  const browser = new Browser();
  await browser.signIn(ana, { trust: true });
  world.mails = [];

  const direct = await browser.signIn(ana);
  assert.equal(direct.askedForCode, false);
  assert.ok(direct.token, 'session straight after the password');
  assert.equal(direct.mails, 0, 'no email sent');
  assert.ok(world.tables.trusteddevices[0].lastUsedAt instanceof Date);

  // wrong password with the cookie: exactly what a wrong password gets without one
  const withCookie = await browser.send(auth.unlock, { body: { email: ana.email, password: 'Wrong-Password-1!' } });
  const without = await new Browser().send(auth.unlock, { body: { email: 'nobody@example.com', password: 'Wrong-Password-1!' } });
  assert.equal(withCookie.error.status, 401);
  assert.equal(withCookie.error.message, without.error.message);
  assert.equal(withCookie.json, null);
});

test("a missing, tampered, expired or another account's cookie gets the ordinary code challenge", async () => {
  reset();
  const ana = addUser('ana@example.com');
  const ben = addUser('ben@example.com');
  const anaBrowser = new Browser();
  const benBrowser = new Browser();
  await anaBrowser.signIn(ana, { trust: true });
  await benBrowser.signIn(ben, { trust: true });
  const anaName = trusted.cookieNameFor(ana._id);
  const anaValue = anaBrowser.jar.get(anaName);
  const benValue = benBrowser.jar.get(trusted.cookieNameFor(ben._id));

  const shape = (r) => Object.keys(r.json).sort().join(',');
  const baseline = await new Browser().send(auth.unlock, { body: { email: ana.email, password: PASSWORD } });
  assert.equal(baseline.json.otpRequired, true);

  const cases = {
    tampered: anaValue.slice(0, -2) + (anaValue.endsWith('A') ? 'BB' : 'AA'),
    garbage: 'x'.repeat(10),
    "ben's cookie value under ana's cookie name": benValue,
  };
  for (const [label, value] of Object.entries(cases)) {
    budgets.clear();
    const browser = new Browser();
    browser.jar.set(anaName, value);
    const result = await browser.send(auth.unlock, { body: { email: ana.email, password: PASSWORD } });
    assert.equal(result.json.otpRequired, true, label);
    assert.equal(shape(result), shape(baseline), label);
    assert.equal(result.error, null, label);
  }

  budgets.clear();
  world.tables.trusteddevices.find((r) => r.tokenHash === trusted.hashToken(anaValue)).expiresAt = new Date(Date.now() - 1000);
  const expired = await anaBrowser.send(auth.unlock, { body: { email: ana.email, password: PASSWORD } });
  assert.equal(expired.json.otpRequired, true);
  assert.equal(shape(expired), shape(baseline));
});

// ---------- the regression: what made a trusted browser ask for a code again ----------

test('REGRESSION: trusting the same browser for a second account does not undo the first account\'s trust', async () => {
  reset();
  const ana = addUser('ana@example.com');
  const ben = addUser('ben@example.com');
  const browser = new Browser();

  await browser.signIn(ana, { trust: true });
  const anaCookie = trusted.cookieNameFor(ana._id);
  const anaValue = browser.jar.get(anaCookie);

  // The same browser, a second account, trust ticked. Before the fix this overwrote Ana's cookie.
  await browser.signIn(ben, { trust: true });
  assert.equal(browser.jar.get(anaCookie), anaValue, "Ana's cookie is still there, unchanged");
  assert.deepEqual(browser.trustCookies().sort(), [anaCookie, trusted.cookieNameFor(ben._id)].sort());

  const again = await browser.signIn(ana);
  assert.equal(again.askedForCode, false, 'Ana signs in with just her password: no code, no email');
  assert.equal(again.mails, 0);
  const benAgain = await browser.signIn(ben);
  assert.equal(benAgain.askedForCode, false, 'and so does Ben');
  assert.equal(world.tables.trusteddevices.length, 2);
  assert.equal(world.tables.devices.length, 2, 'one device row per account, one browser');
});

test('trust survives logout, an expired session, a new IP, a browser update and a full browser restart, for the full 30 days', async () => {
  reset();
  const ana = addUser('ana@example.com');
  const browser = new Browser();
  const first = await browser.signIn(ana, { trust: true });
  assert.equal(first.askedForCode, true);
  const survives = async (label, change = () => {}) => {
    change();
    const result = await browser.signIn(ana);
    assert.equal(result.askedForCode, false, `${label}: no code asked`);
    assert.equal(result.mails, 0, `${label}: no email of any kind`);
  };

  await survives('logout then sign in again', async () => {
    const out = await browser.send(auth.logout, { userId: ana._id, session: { token: first.token } });
    assert.equal(out.error, null);
  });
  await survives('session expired', () => { world.tables.sessions = []; });
  await survives('a different IP address', () => { browser.ip = '198.51.100.77'; });
  await survives('a browser update (new User-Agent)', () => { browser.userAgent = UA_UPDATED; });
  await survives('the browser closed and reopened (cookies kept, session storage gone)', () => { world.tables.sessions = []; });

  // 29 days after trusting: still trusted. 31 days after: asked again.
  const [record] = world.tables.trusteddevices;
  record.createdAt = new Date(Date.now() - 29 * DAY);
  record.expiresAt = new Date(Date.now() + 1 * DAY);
  await survives('29 days later');
  record.expiresAt = new Date(Date.now() - 1000);
  const late = await browser.signIn(ana);
  assert.equal(late.askedForCode, true, 'after the 30 days it asks for a code again');
});

test('a trust cookie from before the per-account names is honoured once and converted', async () => {
  reset();
  const ana = addUser('ana@example.com');
  const old = new Browser();
  await old.signIn(ana, { trust: true });
  // Rebuild what such a browser held: the same token under the old shared name only.
  const value = old.jar.get(trusted.cookieNameFor(ana._id));
  const legacy = new Browser();
  legacy.jar.set(trusted.LEGACY_COOKIE_NAME, value);
  world.mails = [];
  const result = await legacy.signIn(ana);
  assert.equal(result.askedForCode, false, 'nobody who was trusted is asked for a code because of the change');
  assert.equal(legacy.jar.get(trusted.cookieNameFor(ana._id)), value, 'now under her own name');
  assert.equal(legacy.jar.has(trusted.LEGACY_COOKIE_NAME), false, 'and the old name is gone');
  const next = await legacy.signIn(ana);
  assert.equal(next.askedForCode, false);
});

// ---------- 1b: which emails are sent at sign-in ----------

test('1b: signing in sends only the sign-in code (never a verification link), and verification stays permanent', async () => {
  reset();
  const ana = addUser('ana@example.com');
  const browser = new Browser();
  const mailsBefore = world.mails.length;

  const first = await browser.signIn(ana, { trust: true });
  assert.equal(first.askedForCode, true);
  // the sign-in code, and the heads-up that a browser is now trusted - nothing about verifying the account
  assert.deepEqual(subjects(mailsBefore), ['Your Warden sign-in code', 'New trusted browser on your Warden account']);

  world.mails = [];
  await browser.signIn(ana); // trusted: no email at all
  assert.deepEqual(subjects(), []);

  world.mails = [];
  const other = new Browser();
  await other.signIn(ana); // not trusted: exactly one email, the code
  // (a second, unknown browser also gets the new-device notice - that is a different email, not a verification)
  assert.deepEqual(subjects(), ['Your Warden sign-in code', 'New device signed in to your Warden account']);

  for (const mail of world.mails) assert.doesNotMatch(mail.subject, /verif/i);
  assert.equal(ana.emailVerified, true, 'still verified after every kind of sign-in');
});

test('1b: only signup (for an unverified account) and an explicit resend send a verification email', async () => {
  reset();
  const verified = addUser('verified@example.com');
  const pending = addUser('pending@example.com', { verified: false });
  pending.verificationTokenHash = 'x';
  pending.verificationTokenExpiresAt = new Date(Date.now() + DAY);

  // an UNVERIFIED account trying to sign in is told so; no email is sent by the attempt
  world.mails = [];
  const blocked = await new Browser().send(auth.unlock, { body: { email: pending.email, password: PASSWORD } });
  assert.equal(blocked.error.status, 403);
  assert.equal(blocked.error.emailVerificationRequired, true);
  assert.deepEqual(subjects(), [], 'signing in never sends a verification email');

  // resend: a verified account gets nothing (and the same answer); an unverified one gets the link
  const resendFor = (email) => call(auth.resendVerification, { body: { email } });
  const forVerified = await resendFor(verified.email);
  assert.deepEqual(subjects(), [], 'no verification email for a verified account');
  const forPending = await resendFor(pending.email);
  assert.deepEqual(subjects(), ['Your new Warden verification link']);
  assert.deepEqual(forVerified.json, forPending.json, 'the same answer either way');

  // structural: the two verification templates are used in exactly these two places
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const users = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(__dirname, '..', dir), { withFileTypes: true })) {
      if (['node_modules', 'test', 'scripts'].includes(entry.name)) continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/templates\.verifyEmail(Resend)?\(/.test(src(rel))) users.push(rel);
    }
  };
  for (const dir of ['controllers', 'utils', 'routes', 'middleware']) walk(dir);
  assert.deepEqual(users, ['controllers/auth.controller.js']);
  const text = src('controllers/auth.controller.js');
  const signup = text.slice(text.indexOf('const signup ='), text.indexOf('const verifyEmail ='));
  const resend = text.slice(text.indexOf('const resendVerification ='), text.indexOf('const getPublicConfig'));
  assert.match(signup, /templates\.verifyEmail\(/);
  assert.match(resend, /!user\.emailVerified[\s\S]*templates\.verifyEmailResend\(/);
  // the unlock, verify-otp and issue-session code never mention verification templates or clear the flag
  const login = text.slice(text.indexOf('async function issueLoginSession'), text.indexOf('const getMe ='));
  assert.doesNotMatch(login, /verifyEmail|verifyEmailResend/);
  assert.doesNotMatch(login, /emailVerified\s*=\s*false/);
  for (const file of ['utils/accountReset.js', 'controllers/passwordReset.controller.js']) assert.doesNotMatch(src(file), /emailVerified\s*=\s*false/, file);
});

// ---------- removing trust ----------

test('the account page lists trusted browsers (marking this one) and removes one or all', async () => {
  reset();
  const ana = addUser('ana@example.com');
  const ben = addUser('ben@example.com');
  const chromeBrowser = new Browser(UA);
  const firefoxBrowser = new Browser(FIREFOX_LINUX);
  await chromeBrowser.signIn(ana, { trust: true });
  await firefoxBrowser.signIn(ana, { trust: true });
  await new Browser().signIn(ben, { trust: true });

  const listed = await chromeBrowser.send(account.listTrustedDevices, { userId: ana._id });
  assert.equal(listed.json.devices.length, 2, 'only her own');
  assert.deepEqual(listed.json.devices.map((d) => d.label).sort(), ['Chrome on Windows', 'Firefox on Linux']);
  assert.equal(listed.json.devices.filter((d) => d.current).length, 1);
  assert.ok(!JSON.stringify(listed.json).includes('tokenHash'));
  const chrome = listed.json.devices.find((d) => d.label === 'Chrome on Windows');
  assert.equal(chrome.current, true);

  const foreign = await call(account.removeTrustedDevice, { userId: ben._id, params: { id: chrome.id } });
  assert.equal(foreign.error.status, 404);
  assert.equal(world.tables.trusteddevices.length, 3);
  assert.equal((await call(account.removeTrustedDevice, { userId: ana._id, params: { id: 'nope' } })).error.status, 404);

  const removed = await chromeBrowser.send(account.removeTrustedDevice, { userId: ana._id, params: { id: chrome.id } });
  assert.equal(removed.status, 204);
  assert.deepEqual(removed.cleared.sort(), [trusted.cookieNameFor(ana._id), trusted.LEGACY_COOKIE_NAME].sort(), 'removing this browser also clears its cookie (and the old shared name)');
  assert.equal((await chromeBrowser.signIn(ana)).askedForCode, true, 'asks for a code again');
  assert.equal((await firefoxBrowser.signIn(ana)).askedForCode, false, 'the other one still works');

  const all = await firefoxBrowser.send(account.removeAllTrustedDevices, { userId: ana._id });
  assert.equal(all.json.removed, 1);
  assert.equal((await firefoxBrowser.signIn(ana)).askedForCode, true);
  assert.equal(world.tables.trusteddevices.length, 1, "ben's is untouched");
});

test('"Forget this browser", sign out one device, and sign out others (with the forget option) remove trust; the caller keeps theirs', async () => {
  reset();
  const ana = addUser('ana@example.com');
  const here = new Browser();
  const laptop = new Browser(FIREFOX_LINUX);
  const phone = new Browser('Mozilla/5.0 (Linux; Android 14) Chrome/126 Mobile Safari/537.36');
  const hereIn = await here.signIn(ana, { trust: true });
  const laptopIn = await laptop.signIn(ana, { trust: true });
  const phoneIn = await phone.signIn(ana, { trust: true });
  const devices = world.tables.devices;
  assert.equal(devices.length, 3);
  const deviceOf = (browser) => devices.find((d) => d.deviceIdHash === trusted.hashToken(browser.jar.get('warden_did')));
  const me = { userId: ana._id, deviceId: deviceOf(here)._id, session: { idHash: world.tables.sessions.find((s) => String(s.deviceId) === String(deviceOf(here)._id)).sessionIdHash } };

  // forget one browser's trust only: its session stays, the next sign-in there asks for a code
  const forget = await call(security.forgetTrustedDevice, { ...me, params: { id: String(deviceOf(laptop)._id) } });
  assert.equal(forget.status, 200);
  assert.equal(deviceOf(laptop).trusted, false);
  assert.equal((await laptop.signIn(ana)).askedForCode, true);
  assert.equal(world.tables.sessions.filter((s) => String(s.deviceId) === String(deviceOf(phone)._id)).length, 1);

  // sign out the phone: sessions and trust gone, the others untouched
  const out = await call(security.signOutDevice, { ...me, params: { id: String(deviceOf(phone)._id) } });
  assert.equal(out.status, 200);
  assert.equal(out.json.self, false);
  assert.equal(world.tables.sessions.filter((s) => String(s.deviceId) === String(deviceOf(phone)._id)).length, 0);
  assert.equal(world.tables.trusteddevices.filter((t) => String(t.deviceId) === String(deviceOf(phone)._id)).length, 0);
  assert.equal((await phone.signIn(ana)).askedForCode, true, 'the phone now needs a code again');

  // sign out others with the forget option: this browser keeps its session AND its trust
  await laptop.signIn(ana, { trust: true });
  const others = await call(security.signOutOthers, { ...me, body: { forgetTrusted: true } });
  assert.equal(others.status, 200);
  assert.ok(world.tables.sessions.some((s) => s.sessionIdHash === me.session.idHash), 'the caller\'s own session is untouched');
  assert.equal(world.tables.sessions.filter((s) => s.sessionIdHash !== me.session.idHash).length, 0);
  assert.equal((await here.signIn(ana)).askedForCode, false, 'this browser is still trusted');
  assert.equal((await laptop.signIn(ana)).askedForCode, true, 'every other browser lost its trust');
  assert.ok(hereIn.token && laptopIn.token && phoneIn.token);
});

test('password reset / wipe (all sessions) and account deletion remove every trusted browser', async () => {
  reset();
  const ana = addUser('ana@example.com');
  const ben = addUser('ben@example.com');
  await new Browser().signIn(ana, { trust: true });
  await new Browser().signIn(ana, { trust: true });
  await new Browser().signIn(ben, { trust: true });
  assert.equal(world.tables.trusteddevices.length, 3);

  await destroyAllSessionsForUser(ana._id); // what the password reset ends with
  assert.deepEqual(world.tables.trusteddevices.map((r) => String(r.userId)), [String(ben._id)]);
  assert.ok(world.tables.devices.filter((d) => String(d.userId) === String(ana._id)).every((d) => d.trusted === false), 'devices are no longer marked trusted');

  await deleteAccountData(ben._id, { transaction: false });
  assert.equal(world.tables.trusteddevices.length, 0);

  const source = fs.readFileSync(path.join(__dirname, '..', 'utils', 'accountReset.js'), 'utf8');
  const finish = source.slice(source.indexOf('async function finishReset'));
  assert.match(finish, /destroyAllSessionsForUser/);
  assert.match(finish, /revokeAllTrustedDevices/);
});

test('a trusted browser still needs a fresh code for deleting the account and share emails', async () => {
  reset();
  const ana = addUser('ana@example.com');
  const browser = new Browser();
  await browser.signIn(ana, { trust: true });
  world.mails = [];
  const del = await browser.send(account.deleteChallenge, { userId: ana._id, body: { password: PASSWORD } });
  assert.equal(del.json.otpRequired, true);
  assert.equal(world.mails.length, 1, 'a deletion code was emailed regardless of the trusted cookie');
  const withoutCode = await browser.send(account.deleteAccount, {
    userId: ana._id,
    body: { challengeToken: 'x.y', code: '000000', emailConfirmation: ana.email },
  });
  assert.equal(withoutCode.error.status, 401);
  assert.equal(world.tables.users.length, 1, 'nothing deleted');

  // Structural: only login (unlock) consults the cookie.
  const root = path.join(__dirname, '..');
  const users = [];
  for (const folder of ['controllers', 'routes', 'middleware', 'utils']) {
    for (const name of fs.readdirSync(path.join(root, folder))) {
      if (fs.statSync(path.join(root, folder, name)).isDirectory()) continue;
      const text = fs.readFileSync(path.join(root, folder, name), 'utf8');
      if (/isTrustedFor/.test(text)) users.push(`${folder}/${name}`);
    }
  }
  assert.deepEqual(users.sort(), ['controllers/auth.controller.js', 'utils/trustedDevice.js']);
  const authSrc = fs.readFileSync(path.join(root, 'controllers', 'auth.controller.js'), 'utf8');
  assert.equal((authSrc.match(/isTrustedFor\(/g) || []).length, 1);
  const unlockBody = authSrc.slice(authSrc.indexOf('const unlock ='), authSrc.indexOf('const verifyOtp'));
  assert.match(unlockBody, /isTrustedFor\(/);
});

test('user-agent labels are coarse and the cookie reader is strict', () => {
  assert.equal(trusted.labelFromUserAgent(UA), 'Chrome on Windows');
  assert.equal(
    trusted.labelFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605 Version/17 Safari/605.1.15'),
    'Safari on macOS'
  );
  assert.equal(trusted.labelFromUserAgent(undefined), 'Browser on unknown system');
  const name = trusted.cookieNameFor('abc');
  assert.equal(trusted.readCookie({ headers: { cookie: `a=1; ${name}=${'A'.repeat(43)}` } }, name), 'A'.repeat(43));
  assert.equal(trusted.readCookie({ headers: { cookie: `${name}=short` } }, name), null);
  assert.equal(trusted.readCookie({ headers: {} }, name), null);
  assert.notEqual(trusted.cookieNameFor('abc'), trusted.cookieNameFor('abd'));
});
