// Run with: cd server && npm test   (Node's built-in test runner, no deps)
//
// "Trust this browser": after a correct emailed code the owner can skip the
// code - never the password - on that browser for 30 days. In-memory fakes.
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
const { destroyAllSessionsForUser } = require('../utils/sessionStore');
const { deleteAccountData } = require('../utils/accountDeletion');
const trusted = require('../utils/trustedDevice');
const { call } = db;

const PASSWORD = 'Tk9$Lantern-Orbit%57';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0';

function addUser(email) {
  const salt = cryptoUtils.generateSalt();
  const dek = cryptoUtils.generateDEK();
  const wrapped = cryptoUtils.wrapKey(dek, cryptoUtils.deriveEncryptionKey(PASSWORD, salt));
  const user = {
    _id: db.oid(), email, emailVerified: true, salt, passwordHash: cryptoUtils.hashPassword(PASSWORD, salt),
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
const lastCode = () => world.mails.at(-1).text.match(/\b(\d{6})\b/)[1];
const cookieHeader = (value) => ({ cookie: `other=1; ${trusted.COOKIE_NAME}=${value}; x=2`, 'user-agent': UA });
const cookieOf = (result) => result.cookies[trusted.COOKIE_NAME].value;

async function login(email, { password = PASSWORD, headers = { 'user-agent': UA }, trustDevice } = {}) {
  budgets.clear(); // each login here stands for a separate hour of use
  const first = await call(auth.unlock, { body: { email, password }, headers });
  if (first.error || first.json.sessionToken) return { first };
  const second = await call(auth.verifyOtp, { body: { challengeToken: first.json.challengeToken, code: lastCode(), trustDevice }, headers });
  return { first, second };
}

test('ticking the box sets a hardened cookie and stores only a hash', async () => {
  reset();
  const ana = addUser('ana@example.com');
  const { second } = await login(ana.email, { trustDevice: true });
  assert.ok(second.json.sessionToken);
  const cookie = second.cookies[trusted.COOKIE_NAME];
  assert.ok(cookie, 'cookie issued');
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'strict');
  assert.equal(cookie.secure, true);
  assert.equal(cookie.path, '/api');
  assert.equal(cookie.maxAge, 30 * 24 * 3600 * 1000);
  assert.equal(world.tables.trusteddevices.length, 1);
  const [row] = world.tables.trusteddevices;
  assert.equal(row.tokenHash, trusted.hashToken(cookie.value));
  assert.ok(Math.abs(row.expiresAt - (Date.now() + 30 * 24 * 3600 * 1000)) < 5000);
  assert.equal(row.label, 'Chrome on Windows');
  assert.ok(!JSON.stringify(world.tables).includes(cookie.value), 'the raw token is stored nowhere');
  assert.ok(!Object.keys(row).some((k) => /ip/i.test(k)), 'no IP stored');
});

test('only an explicit true trusts the browser; unticked asks for a code every time', async () => {
  reset();
  const ana = addUser('ana@example.com');
  for (const value of [undefined, false, 'true', 1, 'yes']) {
    const { second } = await login(ana.email, { trustDevice: value });
    assert.deepEqual(second.cookies, {});
  }
  assert.equal(world.tables.trusteddevices.length, 0);
  const again = await call(auth.unlock, { body: { email: ana.email, password: PASSWORD } });
  assert.equal(again.json.otpRequired, true);
});

test('a trusted browser skips the code, but never the password', async () => {
  reset();
  const ana = addUser('ana@example.com');
  const { second } = await login(ana.email, { trustDevice: true });
  const cookie = cookieOf(second);
  world.mails = [];

  const direct = await call(auth.unlock, { body: { email: ana.email, password: PASSWORD }, headers: cookieHeader(cookie) });
  assert.equal(direct.error, null);
  assert.ok(direct.json.sessionToken, 'session straight away');
  assert.equal(direct.json.otpRequired, undefined);
  assert.equal(world.mails.length, 0, 'no email sent');
  assert.ok(world.tables.trusteddevices[0].lastUsedAt instanceof Date);

  // wrong password with the cookie: exactly what a wrong password gets without one
  const withCookie = await call(auth.unlock, { body: { email: ana.email, password: 'Wrong-Password-1!' }, headers: cookieHeader(cookie) });
  const without = await call(auth.unlock, { body: { email: 'nobody@example.com', password: 'Wrong-Password-1!' }, headers: { 'user-agent': UA } });
  assert.equal(withCookie.error.status, 401);
  assert.equal(withCookie.error.message, without.error.message);
  assert.equal(withCookie.json, null);
});

test("a missing, tampered, expired or another account's cookie gets the ordinary code challenge", async () => {
  reset();
  const ana = addUser('ana@example.com');
  const ben = addUser('ben@example.com');
  const anaTrust = cookieOf((await login(ana.email, { trustDevice: true })).second);
  const benTrust = cookieOf((await login(ben.email, { trustDevice: true })).second);

  const shape = (r) => Object.keys(r.json).sort().join(',');
  const baseline = await call(auth.unlock, { body: { email: ana.email, password: PASSWORD }, headers: { 'user-agent': UA } });
  assert.equal(baseline.json.otpRequired, true);

  const tampered = anaTrust.slice(0, -2) + (anaTrust.endsWith('A') ? 'BB' : 'AA');
  const cases = {
    tampered,
    garbage: 'x'.repeat(10),
    "ben's cookie on ana's login": benTrust,
    'not base64url': 'a b;c'.repeat(8),
  };
  for (const [name, value] of Object.entries(cases)) {
    budgets.clear();
    const result = await call(auth.unlock, { body: { email: ana.email, password: PASSWORD }, headers: cookieHeader(value) });
    assert.equal(result.json.otpRequired, true, name);
    assert.equal(shape(result), shape(baseline), name);
    assert.equal(result.error, null, name);
  }

  budgets.clear();
  world.tables.trusteddevices.find((r) => r.tokenHash === trusted.hashToken(anaTrust)).expiresAt = new Date(Date.now() - 1000);
  const expired = await call(auth.unlock, { body: { email: ana.email, password: PASSWORD }, headers: cookieHeader(anaTrust) });
  assert.equal(expired.json.otpRequired, true);
  assert.equal(shape(expired), shape(baseline));
});

test('Account lists trusted browsers (marking this one) and removes one or all', async () => {
  reset();
  const ana = addUser('ana@example.com');
  const ben = addUser('ben@example.com');
  const a1 = cookieOf((await login(ana.email, { trustDevice: true, headers: { 'user-agent': UA } })).second);
  const a2 = cookieOf((await login(ana.email, { trustDevice: true, headers: { 'user-agent': FIREFOX_LINUX } })).second);
  await login(ben.email, { trustDevice: true });

  const listed = await call(account.listTrustedDevices, { userId: ana._id, headers: cookieHeader(a1) });
  assert.equal(listed.json.devices.length, 2, 'only her own');
  assert.deepEqual(listed.json.devices.map((d) => d.label).sort(), ['Chrome on Windows', 'Firefox on Linux']);
  assert.equal(listed.json.devices.filter((d) => d.current).length, 1);
  assert.ok(!JSON.stringify(listed.json).includes('tokenHash'));
  const chrome = listed.json.devices.find((d) => d.label === 'Chrome on Windows');
  assert.equal(chrome.current, true);

  // ben cannot remove ana's entry: 404, and nothing changes
  const foreign = await call(account.removeTrustedDevice, { userId: ben._id, params: { id: chrome.id } });
  assert.equal(foreign.error.status, 404);
  assert.equal(world.tables.trusteddevices.length, 3);
  assert.equal((await call(account.removeTrustedDevice, { userId: ana._id, params: { id: 'nope' } })).error.status, 404);

  const removed = await call(account.removeTrustedDevice, { userId: ana._id, params: { id: chrome.id }, headers: cookieHeader(a1) });
  assert.equal(removed.status, 204);
  assert.deepEqual(removed.cleared, [trusted.COOKIE_NAME], 'removing this browser also clears its cookie');
  const afterOne = await call(auth.unlock, { body: { email: ana.email, password: PASSWORD }, headers: cookieHeader(a1) });
  assert.equal(afterOne.json.otpRequired, true, 'asks for a code again');
  assert.ok((await call(auth.unlock, { body: { email: ana.email, password: PASSWORD }, headers: cookieHeader(a2) })).json.sessionToken, 'the other one still works');

  const all = await call(account.removeAllTrustedDevices, { userId: ana._id });
  assert.equal(all.json.removed, 1);
  assert.equal((await call(auth.unlock, { body: { email: ana.email, password: PASSWORD }, headers: cookieHeader(a2) })).json.otpRequired, true);
  assert.equal(world.tables.trusteddevices.length, 1, "ben's is untouched");
});

test('password reset / wipe (all sessions) and account deletion remove every trusted browser', async () => {
  reset();
  const ana = addUser('ana@example.com');
  const ben = addUser('ben@example.com');
  await login(ana.email, { trustDevice: true });
  await login(ana.email, { trustDevice: true });
  await login(ben.email, { trustDevice: true });
  assert.equal(world.tables.trusteddevices.length, 3);

  await destroyAllSessionsForUser(ana._id); // what reset-password and phone recovery end with
  assert.deepEqual(world.tables.trusteddevices.map((r) => String(r.userId)), [String(ben._id)]);

  await deleteAccountData(ben._id, { transaction: false });
  assert.equal(world.tables.trusteddevices.length, 0);

  const source = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'auth.controller.js'), 'utf8');
  const resetBody = source.slice(source.indexOf('const resetPassword'), source.indexOf('const recoverViaUsb'));
  assert.match(resetBody, /destroyAllSessionsForUser/);
});

test('a trusted browser still needs a fresh code for deleting the account, phone recovery and share emails', async () => {
  reset();
  const ana = addUser('ana@example.com');
  const cookie = cookieOf((await login(ana.email, { trustDevice: true })).second);
  world.mails = [];
  const del = await call(account.deleteChallenge, { userId: ana._id, body: { password: PASSWORD }, headers: cookieHeader(cookie) });
  assert.equal(del.json.otpRequired, true);
  assert.equal(world.mails.length, 1, 'a deletion code was emailed regardless of the trusted cookie');
  const withoutCode = await call(account.deleteAccount, {
    userId: ana._id,
    body: { challengeToken: 'x.y', code: '000000', emailConfirmation: ana.email },
    headers: cookieHeader(cookie),
  });
  assert.equal(withoutCode.error.status, 401);
  assert.equal(world.tables.users.length, 1, 'nothing deleted');

  // Structural: only login (unlock) consults the cookie.
  const root = path.join(__dirname, '..');
  const users = [];
  for (const folder of ['controllers', 'routes', 'middleware', 'utils']) {
    for (const name of fs.readdirSync(path.join(root, folder))) {
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
  assert.equal(trusted.readCookie({ headers: { cookie: `a=1; ${trusted.COOKIE_NAME}=${'A'.repeat(43)}` } }), 'A'.repeat(43));
  assert.equal(trusted.readCookie({ headers: { cookie: `${trusted.COOKIE_NAME}=short` } }), null);
  assert.equal(trusted.readCookie({ headers: {} }), null);
});
