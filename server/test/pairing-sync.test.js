// Run with: cd server && npm test
//
// Pairing a phone, the device token, revoking, and the paged sync - on the
// in-memory fake models, so every collection can be inspected afterwards.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

delete process.env.OTP_ENABLED;
delete process.env.VERCEL;
delete process.env.PUBLIC_APP_URL;
for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']) delete process.env[name];
process.env.NODE_ENV = 'test';

const cryptoUtils = require('../utils/crypto');
const db = require('./helpers/fakeDb');

const world = db.createWorld();
db.installModels(world);
const budgets = db.installRateLimit();
db.installMailer(world);

const pairing = require('../controllers/pairing.controller');
const devices = require('../controllers/devices.controller');
const sync = require('../controllers/sync.controller');
const requireDeviceAuth = require('../middleware/requireDeviceAuth');
const { hashToken } = require('../utils/deviceTokens');
const { deleteAccountData } = require('../utils/accountDeletion');
const { call } = db;

const PASSWORD = 'Tk9$Lantern-Orbit%57';
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const UA_PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const PAIR_FAILED = pairing.PAIR_FAILED;
const MIB = 1024 * 1024;

function clearWorld() {
  for (const name of Object.keys(world.tables)) world.tables[name] = [];
  world.mails = [];
  budgets.clear();
}

function addUser(email) {
  const salt = cryptoUtils.generateSalt();
  const dek = cryptoUtils.generateDEK();
  const wrapped = cryptoUtils.wrapKey(dek, cryptoUtils.deriveEncryptionKey(PASSWORD, salt));
  const user = {
    _id: db.oid(), email, emailVerified: true, salt,
    passwordHash: cryptoUtils.hashPassword(PASSWORD, salt),
    wrappedDEKPassword: wrapped.wrappedKey, wrappedDEKPasswordIv: wrapped.iv, wrappedDEKPasswordAuthTag: wrapped.authTag,
    failedAttempts: 0, save: async () => {},
  };
  world.tables.users.push(user);
  return { user, dek };
}

const lastCode = () => /\b(\d{6})\b/.exec(world.mails.at(-1).text)[1];

/** The owner's side: emailed code, then the QR token. Returns the raw pairing token. */
async function ownerCreatesQr(userId) {
  const challenge = await call(pairing.requestPairCode, { userId });
  assert.equal(challenge.error, null);
  const init = await call(pairing.initPairing, { userId, body: { challengeToken: challenge.json.challengeToken, code: lastCode() } });
  assert.equal(init.error, null);
  return init.json;
}

const completeBody = (token, extra = {}) => ({ pairingToken: token, masterPassword: PASSWORD, deviceName: "Josh's Phone", ...extra });
const complete = (body, headers = { 'user-agent': UA_PHONE }) => call(pairing.completePairing, { body, headers });

let alice;
let bob;
function setup() {
  clearWorld();
  alice = addUser('alice@example.com');
  bob = addUser('bob@example.com');
}

// ---------- the emailed code gate ----------

test('creating a pairing QR needs the emailed code: a valid session alone cannot', async () => {
  setup();
  const userId = alice.user._id;

  // asking for a code emails it to the account and creates no token
  const challenge = await call(pairing.requestPairCode, { userId });
  assert.equal(world.mails.length, 1);
  assert.equal(world.mails[0].to, 'alice@example.com');
  assert.match(world.mails[0].subject, /pairing a device/i);
  assert.equal(world.tables.pairingtokens.length, 0);

  // init without a code, or with a wrong one, makes nothing
  assert.equal((await call(pairing.initPairing, { userId, body: {} })).error.status, 400);
  const wrong = await call(pairing.initPairing, { userId, body: { challengeToken: challenge.json.challengeToken, code: '000000' } });
  assert.equal(wrong.error.status, 401);
  assert.equal(world.tables.pairingtokens.length, 0);

  // the right code works once
  const right = await call(pairing.initPairing, { userId, body: { challengeToken: challenge.json.challengeToken, code: lastCode() } });
  assert.equal(right.error, null);
  assert.equal(right.status, 201);
  assert.equal(world.tables.pairingtokens.length, 1);
  const again = await call(pairing.initPairing, { userId, body: { challengeToken: challenge.json.challengeToken, code: lastCode() } });
  assert.equal(again.error.status, 401, 'a code is single use');
  assert.equal(world.tables.pairingtokens.length, 1);
});

test('the code is for pairing only, belongs to its account, and is counted per guess', async () => {
  setup();
  const aliceId = alice.user._id;
  const challenge = await call(pairing.requestPairCode, { userId: aliceId });
  const code = lastCode();

  // another account cannot use Alice's code even with her challenge token
  const stolen = await call(pairing.initPairing, { userId: bob.user._id, body: { challengeToken: challenge.json.challengeToken, code } });
  assert.equal(stolen.error.status, 401);

  // a login code is not a pairing code
  const { startChallenge, PURPOSES } = require('../utils/otpChallenge');
  const login = await startChallenge({ user: alice.user, secret: crypto.randomBytes(32), purpose: PURPOSES.login });
  const loginCode = lastCode();
  const crossed = await call(pairing.initPairing, { userId: aliceId, body: { challengeToken: login.challengeToken, code: loginCode } });
  assert.equal(crossed.error.status, 401);
  assert.equal(world.tables.pairingtokens.length, 0);

  // five wrong guesses kill the challenge; even the right code then fails
  for (let i = 0; i < 5; i += 1) await call(pairing.initPairing, { userId: aliceId, body: { challengeToken: challenge.json.challengeToken, code: '111111' } });
  const dead = await call(pairing.initPairing, { userId: aliceId, body: { challengeToken: challenge.json.challengeToken, code } });
  assert.equal(dead.error.status, 401);
});

test('the QR points at the validated public origin when one is set, otherwise the page decides', async () => {
  setup();
  let init = await ownerCreatesQr(alice.user._id);
  assert.equal(init.appUrl, null, 'no PUBLIC_APP_URL in development: the browser uses its own origin');
  process.env.PUBLIC_APP_URL = 'https://warden.example.com';
  try {
    init = await ownerCreatesQr(alice.user._id);
    assert.equal(init.appUrl, 'https://warden.example.com');
    assert.ok(!('apiBase' in init), 'no API address in the response');
  } finally {
    delete process.env.PUBLIC_APP_URL;
  }
});

// ---------- tokens at rest ----------

test('pairing and device tokens are stored only as SHA-256; the raw value is shown once', async () => {
  setup();
  const init = await ownerCreatesQr(alice.user._id);
  const raw = init.pairingToken;
  assert.match(raw, /^[0-9a-f]{64}$/);
  const row = world.tables.pairingtokens[0];
  assert.equal(row.tokenHash, hashToken(raw));
  assert.equal(row.token, undefined);
  assert.ok(!JSON.stringify(world.tables.pairingtokens).includes(raw), 'the raw pairing token is nowhere in the database');
  assert.ok(row.expiresAt.getTime() - Date.now() <= 5 * 60 * 1000 + 1000, 'five minute lifetime');

  const done = await complete(completeBody(raw));
  assert.equal(done.error, null);
  const deviceToken = done.json.deviceToken;
  assert.match(deviceToken, /^[0-9a-f]{64}$/);
  const device = world.tables.paireddevices[0];
  assert.equal(device.tokenHash, hashToken(deviceToken));
  assert.equal(device.deviceToken, undefined);
  assert.ok(!JSON.stringify(world.tables).includes(deviceToken), 'the raw device token is nowhere in the database');
  assert.equal(await call(pairing.getPairingStatus, { userId: alice.user._id, params: { token: raw } }).then((r) => r.json.used), true);
});

test('the TTL index exists so expired pairing tokens disappear on their own, and the models hold no raw tokens or PIN wraps', () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const tokenModel = read('models', 'PairingToken.js');
  assert.match(tokenModel, /expiresAt: 1 \}, \{ expireAfterSeconds: 0 \}/);
  assert.match(tokenModel, /tokenHash: \{ type: String, required: true, unique: true \}/);
  const deviceModel = read('models', 'PairedDevice.js').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(deviceModel, /wrappedDEK|deviceToken:|salt/i);
  assert.match(deviceModel, /tokenHash/);
  const controller = read('controllers', 'pairing.controller.js').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(controller, /phonePin|\bwrapKey\(|generateSalt/, 'the server neither receives the PIN nor wraps anything under it');
});

// ---------- completing a pairing ----------

test('pairing returns the device token and the vault key once; the phone sends no PIN and the server keeps no PIN wrap', async () => {
  setup();
  const { pairingToken } = await ownerCreatesQr(alice.user._id);
  const done = await complete(completeBody(pairingToken, { phonePin: '4829' }));
  assert.equal(done.status, 201);
  assert.deepEqual(Object.keys(done.json).sort(), ['dek', 'deviceId', 'deviceToken']);
  assert.deepEqual(Buffer.from(done.json.dek, 'base64'), Buffer.from(alice.dek));
  const device = world.tables.paireddevices[0];
  assert.equal(String(device.userId), String(alice.user._id));
  assert.equal(device.deviceName, "Josh's Phone");
  assert.equal(device.browserLabel, 'Chrome on Android');
  assert.deepEqual(Object.keys(device).filter((key) => /wrapped|pin|salt/i.test(key)), []);
  assert.ok(!JSON.stringify(world.tables).includes('4829'), 'a PIN sent anyway is not stored');
});

test('the owner is emailed when a device is paired', async () => {
  setup();
  const { pairingToken } = await ownerCreatesQr(alice.user._id);
  world.mails.length = 0;
  await complete(completeBody(pairingToken));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(world.mails.length, 1);
  const mail = world.mails[0];
  assert.equal(mail.to, 'alice@example.com');
  assert.match(mail.subject, /new device was paired/i);
  assert.match(mail.text, /Josh's Phone/);
  assert.match(mail.text, /Chrome on Android/);
  assert.match(mail.text, /When: .*Philippine Time \(UTC\+8\)/);
  assert.doesNotMatch(mail.text, /[0-9a-f]{64}/, 'no token in the email');
});

test('single use: a token that paired once is dead', async () => {
  setup();
  const { pairingToken } = await ownerCreatesQr(alice.user._id);
  assert.equal((await complete(completeBody(pairingToken))).status, 201);
  const second = await complete(completeBody(pairingToken));
  assert.equal(second.error.status, 401);
  assert.equal(world.tables.paireddevices.length, 1);
});

test('every failure is the same generic answer: wrong password, unknown, expired, used and killed tokens', async () => {
  setup();
  const answers = new Map();
  const note = (label, result) => answers.set(label, `${result.error.status}|${result.error.message}`);

  const live = await ownerCreatesQr(alice.user._id);
  note('wrong password', await complete(completeBody(live.pairingToken, { masterPassword: 'not-the-password' })));
  note('unknown token', await complete(completeBody('a'.repeat(64))));
  note('malformed token', await complete(completeBody('not-a-token')));

  const old = await ownerCreatesQr(alice.user._id);
  world.tables.pairingtokens.find((t) => t.tokenHash === hashToken(old.pairingToken)).expiresAt = new Date(Date.now() - 1000);
  note('expired (right password)', await complete(completeBody(old.pairingToken)));

  const used = await ownerCreatesQr(alice.user._id);
  await complete(completeBody(used.pairingToken));
  note('used (right password)', await complete(completeBody(used.pairingToken)));

  assert.equal(new Set(answers.values()).size, 1, `all failures look the same: ${JSON.stringify([...answers])}`);
  assert.equal([...answers.values()][0], `401|${PAIR_FAILED}`);
  assert.doesNotMatch(PAIR_FAILED, /incorrect password|wrong password|expired|invalid/i);
});

test('5 wrong passwords kill the token: even the right password fails afterwards', async () => {
  setup();
  const { pairingToken } = await ownerCreatesQr(alice.user._id);
  for (let i = 0; i < 4; i += 1) {
    assert.equal((await complete(completeBody(pairingToken, { masterPassword: `wrong-${i}` }))).error.status, 401);
  }
  assert.equal(world.tables.pairingtokens.length, 1, 'still alive after four');
  assert.equal(world.tables.pairingtokens[0].failedAttempts, 4);
  await complete(completeBody(pairingToken, { masterPassword: 'wrong-4' }));
  assert.equal(world.tables.pairingtokens.length, 0, 'the fifth failure deleted it');
  const late = await complete(completeBody(pairingToken));
  assert.equal(late.error.message, PAIR_FAILED);
  assert.equal(world.tables.paireddevices.length, 0);
});

test('an account allows 10 wrong passwords an hour across all its QR codes, then refuses even the right one', async () => {
  setup();
  for (let batch = 0; batch < 2; batch += 1) {
    const { pairingToken } = await ownerCreatesQr(alice.user._id);
    for (let i = 0; i < 5; i += 1) await complete(completeBody(pairingToken, { masterPassword: 'nope' }));
  }
  assert.equal(budgets.get(`pair-complete-account:${alice.user._id}`), 10);
  const fresh = await ownerCreatesQr(alice.user._id);
  const blocked = await complete(completeBody(fresh.pairingToken));
  assert.equal(blocked.error.status, 429);
  assert.equal(world.tables.paireddevices.length, 0);
  // another account is not affected
  const other = await ownerCreatesQr(bob.user._id);
  assert.equal((await complete(completeBody(other.pairingToken))).status, 201);
});

test('the per-connection limit sits on the route, in front of the controller', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'routes', 'pairComplete.routes.js'), 'utf8');
  assert.match(text, /createRateLimiter\(\{ name: 'pair-complete', max: 10, windowMs: 60 \* 1000 \}\)/);
  const owner = fs.readFileSync(path.join(__dirname, '..', 'routes', 'pairing.routes.js'), 'utf8');
  for (const route of ["'/code'", "'/resend-code'", "'/init'", "'/status/:token'"]) {
    assert.match(owner, new RegExp(`${route.replace(/[/:]/g, '\\$&')}, requireSession`), `${route} needs a session`);
  }
});

// ---------- device authentication, last seen, revoke ----------

async function pairedDevice(owner) {
  const { pairingToken } = await ownerCreatesQr(owner.user._id);
  const done = await complete(completeBody(pairingToken));
  return { id: String(done.json.deviceId), token: done.json.deviceToken };
}
const withDevice = async (token) => {
  const out = { error: null, req: { headers: { authorization: `Bearer ${token}` } } };
  await requireDeviceAuth(out.req, {}, (err) => { out.error = err || null; });
  return out;
};

test('a device token opens the sync API; unknown, malformed and missing tokens are the same 401', async () => {
  setup();
  const device = await pairedDevice(alice);
  const ok = await withDevice(device.token);
  assert.equal(ok.error, null);
  assert.equal(String(ok.req.userId), String(alice.user._id));
  for (const bad of ['b'.repeat(64), 'short', device.token.toUpperCase(), '']) {
    const refused = await withDevice(bad);
    assert.equal(refused.error.status, 401, bad);
    assert.equal(refused.error.code, 'DEVICE_REVOKED');
  }
  const noHeader = { error: null };
  await requireDeviceAuth({ headers: {} }, {}, (err) => { noHeader.error = err; });
  assert.equal(noHeader.error.status, 401);
});

test('last seen is stamped on use, at most once a minute', async () => {
  setup();
  const device = await pairedDevice(alice);
  const row = world.tables.paireddevices[0];
  assert.equal(row.lastSeenAt, null);
  await withDevice(device.token);
  const first = row.lastSeenAt;
  assert.ok(first instanceof Date);
  await withDevice(device.token);
  assert.equal(row.lastSeenAt, first, 'not rewritten within a minute');
  row.lastSeenAt = new Date(Date.now() - 61_000);
  await withDevice(device.token);
  assert.ok(Date.now() - row.lastSeenAt.getTime() < 5000, 'rewritten after a minute');
  const listed = await call(devices.listDevices, { userId: alice.user._id });
  assert.ok(listed.json[0].lastSeenAt instanceof Date);
});

test('the devices list shows name, browser, paired and last-seen, and nothing secret', async () => {
  setup();
  await pairedDevice(alice);
  await pairedDevice(bob);
  const listed = await call(devices.listDevices, { userId: alice.user._id });
  assert.equal(listed.json.length, 1, 'only this account\'s devices');
  assert.deepEqual(Object.keys(listed.json[0]).sort(), ['browserLabel', 'deviceName', 'id', 'lastSeenAt', 'pairedAt', 'revoked', 'revokedAt']);
  assert.ok(!JSON.stringify(listed.json).match(/[0-9a-f]{64}/));
});

test('REVOKE: the next request is refused, the stored hash is gone, and unknown or foreign ids are 404', async () => {
  setup();
  const mine = await pairedDevice(alice);
  const theirs = await pairedDevice(bob);
  assert.equal((await withDevice(mine.token)).error, null);

  for (const id of ['not-an-id', String(db.oid()), theirs.id]) {
    const refused = await call(devices.revokeDevice, { userId: alice.user._id, params: { id } });
    assert.equal(refused.error.status, 404, `${id} is a 404, not a silent success`);
  }
  assert.equal((await withDevice(theirs.token)).error, null, 'a foreign revoke attempt changed nothing');

  const revoked = await call(devices.revokeDevice, { userId: alice.user._id, params: { id: mine.id } });
  assert.equal(revoked.status, 200);
  const row = world.tables.paireddevices.find((d) => String(d._id) === mine.id);
  assert.equal(row.revoked, true);
  assert.ok(row.revokedAt instanceof Date);
  assert.equal(row.tokenHash, undefined, 'the token hash is deleted');
  const afterwards = await withDevice(mine.token);
  assert.equal(afterwards.error.status, 401);
  assert.equal(afterwards.error.code, 'DEVICE_REVOKED');

  assert.equal((await call(devices.revokeDevice, { userId: alice.user._id, params: { id: mine.id } })).status, 200, 'revoking again is fine');
  const listed = await call(devices.listDevices, { userId: alice.user._id });
  assert.equal(listed.json[0].revoked, true);
});

// ---------- the paged sync ----------

function addDoc(userId, name, size, extra = {}) {
  const doc = {
    _id: db.oid(), userId, filename: name, folder: 'root', encryptedBlob: Buffer.alloc(size, 7), iv: 'iv', authTag: 'tag', checksum: 'sum',
    mimeType: 'text/plain', deletedAt: null, createdAt: new Date(), updatedAt: new Date(), ...extra,
  };
  world.tables.documents.push(doc);
  return doc;
}

test('the metadata list is paged by id, flags Trash, carries sizes, never ciphertext, and never another account', async () => {
  setup();
  const ids = [];
  for (let i = 0; i < 25; i += 1) ids.push(String(addDoc(alice.user._id, `f${i}.txt`, 100 + i)._id));
  addDoc(bob.user._id, 'bobs.txt', 10);
  const trashed = world.tables.documents.find((d) => d.filename === 'f3.txt');
  trashed.deletedAt = new Date();

  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const page = await call(sync.listSyncDocuments, { userId: alice.user._id, query: { limit: '10', ...(cursor ? { cursor } : {}) } });
    assert.equal(page.error, null);
    assert.ok(page.json.items.length <= 10);
    assert.ok(!JSON.stringify(page.json).includes('encryptedBlob'));
    seen.push(...page.json.items);
    cursor = page.json.nextCursor || undefined;
    pages += 1;
  } while (cursor);

  assert.equal(pages, 3);
  assert.equal(seen.length, 25, 'every document exactly once, Trash included');
  assert.deepEqual(seen.map((i) => i.id), [...ids].sort());
  assert.ok(seen.every((item) => item.filename !== 'bobs.txt'));
  const trashedItem = seen.find((item) => item.filename === 'f3.txt');
  assert.ok(trashedItem.deletedAt);
  assert.equal(seen.find((item) => item.filename === 'f0.txt').size, 100);
  assert.equal(seen.find((item) => item.filename === 'f0.txt').deletedAt, null);
});

test('page size is clamped, a bad cursor is a 400, and a page of 200 stays tiny next to the host limit', async () => {
  setup();
  for (let i = 0; i < 260; i += 1) addDoc(alice.user._id, `a-long-file-name-for-the-listing-${i}.pdf`, 5);
  const big = await call(sync.listSyncDocuments, { userId: alice.user._id, query: { limit: '100000' } });
  assert.equal(big.json.items.length, sync.MAX_PAGE);
  assert.ok(big.json.nextCursor);
  assert.ok(JSON.stringify(big.json).length < 0.4 * 4.5 * MIB, 'a full page is far below 4.5 MB');
  const tiny = await call(sync.listSyncDocuments, { userId: alice.user._id, query: { limit: '0' } });
  assert.equal(tiny.json.items.length, 1);
  const defaulted = await call(sync.listSyncDocuments, { userId: alice.user._id, query: {} });
  assert.equal(defaulted.json.items.length, 100);
  assert.equal((await call(sync.listSyncDocuments, { userId: alice.user._id, query: { cursor: 'nope' } })).error.status, 400);
  assert.equal((await call(sync.listSyncDocuments, { userId: alice.user._id, query: { cursor: { $gt: '' } } })).error.status, 400);
});

test('a document comes down as raw bytes, one per request, 4 MiB at most; foreign, trashed and unknown ids are 404', async () => {
  setup();
  const small = addDoc(alice.user._id, 'a.bin', 1234);
  const biggest = addDoc(alice.user._id, 'max.bin', 4 * MIB);
  const trashed = addDoc(alice.user._id, 'gone.bin', 10, { deletedAt: new Date() });
  const foreign = addDoc(bob.user._id, 'b.bin', 10);

  const got = await call(sync.getSyncDocumentContent, { userId: alice.user._id, params: { id: String(small._id) } });
  assert.equal(got.status, 200);
  assert.equal(got.headers['content-type'], 'application/octet-stream');
  assert.equal(got.headers['content-length'], '1234');
  assert.deepEqual(got.body, small.encryptedBlob);

  const max = await call(sync.getSyncDocumentContent, { userId: alice.user._id, params: { id: String(biggest._id) } });
  assert.equal(max.body.length, 4 * MIB);
  assert.ok(max.body.length < 4.5 * MIB, 'a 4 MiB file fits under the 4.5 MB response cap as raw bytes (base64 would not)');

  for (const id of [String(trashed._id), String(foreign._id), String(db.oid()), 'nope']) {
    assert.equal((await call(sync.getSyncDocumentContent, { userId: alice.user._id, params: { id } })).error.status, 404, id);
  }
});

const pushBody = (extra = {}) => ({ clientId: 'phone-uuid-1', filename: 'from-phone.txt', folder: '', iv: 'aXY=', authTag: 'dGFn', checksum: 'abc', mimeType: 'text/plain', ...extra });
const push = (userId, ciphertext, body) => call(sync.pushSyncDocument, { userId, file: { buffer: ciphertext }, body });

test('a document pushed from the phone is stored as given, and repeating the push returns the same document', async () => {
  setup();
  const bytes = crypto.randomBytes(2000);
  const first = await push(alice.user._id, bytes, pushBody());
  assert.equal(first.status, 201);
  assert.equal(first.json.duplicate, false);
  assert.equal(world.tables.documents.length, 1);
  const stored = world.tables.documents[0];
  assert.deepEqual(stored.encryptedBlob, bytes, 'ciphertext stored untouched');
  assert.equal(stored.originDevice, 'phone');
  assert.equal(stored.clientId, 'phone-uuid-1');
  assert.equal(String(stored.userId), String(alice.user._id));

  const again = await push(alice.user._id, bytes, pushBody());
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, true);
  assert.equal(again.json.id, first.json.id);
  assert.equal(world.tables.documents.length, 1, 'no second copy');

  // the same clientId from another account is a different document
  assert.equal((await push(bob.user._id, bytes, pushBody())).status, 201);
  assert.equal(world.tables.documents.length, 2);

  // and a document pushed from the phone shows up in the listing with its clientId
  const listing = await call(sync.listSyncDocuments, { userId: alice.user._id, query: {} });
  assert.equal(listing.json.items[0].clientId, 'phone-uuid-1');
});

test('push refuses a missing file or fields, non-text fields, and a full account', async () => {
  setup();
  assert.equal((await call(sync.pushSyncDocument, { userId: alice.user._id, body: pushBody() })).error.status, 400);
  for (const bad of [{ clientId: undefined }, { filename: '' }, { iv: undefined }, { checksum: undefined }, { folder: { $ne: 1 } }, { clientId: 'x'.repeat(81) }]) {
    assert.equal((await push(alice.user._id, Buffer.alloc(4), pushBody(bad))).error.status, 400, JSON.stringify(bad));
  }
  assert.equal(world.tables.documents.length, 0);
  process.env.STORAGE_QUOTA_MB = '1';
  try {
    addDoc(alice.user._id, 'existing.bin', 1);
    // (the fake database cannot total sizes, so check the quota guard is called on the byte length)
    const text = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'sync.controller.js'), 'utf8');
    assert.match(text, /assertCanStore\(req\.userId, file\.buffer\.length\)/);
  } finally {
    delete process.env.STORAGE_QUOTA_MB;
  }
});

test('the multipart route has a 4 MiB file cap, authenticates before reading the body, and the old pull and push are gone (410)', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sync.routes.js'), 'utf8');
  assert.match(routes, /fileSize: MAX_BLOB_BYTES/);
  assert.equal(sync.MAX_BLOB_BYTES, 4 * MIB);
  assert.match(routes, /router\.post\('\/documents', requireDeviceAuth, handleUpload, pushSyncDocument\)/);
  assert.match(routes, /router\.post\('\/pull', syncMoved\)/);
  assert.match(routes, /router\.post\('\/push', syncMoved\)/);
  const gone = {};
  sync.syncMoved({}, { status(code) { gone.status = code; return this; }, json(body) { gone.body = body; } });
  assert.equal(gone.status, 410);
  assert.match(gone.body.error.message, /out of date/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /express\.json\(\{ limit: '100kb' \}\)/, 'no JSON path carries a document any more');
});

// ---------- account deletion and vault wipe ----------

test('deleting the account removes every device, token, pending challenge and the rate-limit rows', async () => {
  setup();
  await pairedDevice(alice);
  await pairedDevice(bob);
  const live = await ownerCreatesQr(alice.user._id);
  assert.ok(live.pairingToken);
  world.tables.ratelimits.push({ _id: db.oid(), bucket: 'pair-complete-account', key: String(alice.user._id), count: 3 });
  world.tables.ratelimits.push({ _id: db.oid(), bucket: 'pair-complete-account', key: String(bob.user._id), count: 1 });
  await call(pairing.requestPairCode, { userId: alice.user._id });
  assert.ok(world.tables.otpchallenges.some((c) => String(c.userId) === String(alice.user._id)));

  await deleteAccountData(alice.user._id, { email: 'alice@example.com', transaction: false });

  const mineLeft = (table) => world.tables[table].filter((row) => String(row.userId) === String(alice.user._id)).length;
  for (const table of ['paireddevices', 'pairingtokens', 'otpchallenges', 'sessions']) assert.equal(mineLeft(table), 0, table);
  assert.equal(world.tables.ratelimits.filter((r) => r.key === String(alice.user._id)).length, 0);
  assert.equal(world.tables.paireddevices.length, 1, "Bob's device is untouched");
  assert.equal(world.tables.ratelimits.length, 1, "Bob's counter is untouched");
});

test('wiping the vault (reset without the recovery key) removes devices and pairing tokens too', async () => {
  setup();
  await pairedDevice(alice);
  await ownerCreatesQr(alice.user._id);
  const text = fs.readFileSync(path.join(__dirname, '..', 'utils', 'accountReset.js'), 'utf8');
  assert.match(text, /PairedDevice\.deleteMany\(\{ userId \}\)/);
  assert.match(text, /PairingToken\.deleteMany\(\{ userId \}\)/);
  const { wipeVault } = require('../utils/accountReset');
  if (typeof wipeVault === 'function') {
    await wipeVault(alice.user._id);
    assert.equal(world.tables.paireddevices.length, 0);
    assert.equal(world.tables.pairingtokens.length, 0);
  }
});

// ---------- the LAN assumptions are gone ----------

test('no LAN detection, LAN_IP setting or PC-address error is left in the server', () => {
  const root = path.join(__dirname, '..');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'test') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|md|example)$/.test(entry.name)) files.push(full);
    }
  };
  walk(root);
  walk(path.join(root, '..', 'scripts'));
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /resolveLanIp|detectLanIp|LAN_IP|networkInterfaces|Set LAN_IP/, path.relative(root, file));
  }
  assert.equal(fs.existsSync(path.join(root, 'utils', 'lanIp.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'utils', 'network.js')), false);
});

// ---------- the one-time migration ----------

test('MIGRATION: clear tokens become hashes, revoked devices keep none, PIN wraps are deleted, old indexes dropped, and a second run changes nothing', async () => {
  const mongoose = require('mongoose');
  const collections = {
    migrations: [],
    pairingtokens: [{ _id: 1, token: 'c'.repeat(64), userId: 'u' }, { _id: 2, tokenHash: 'keep', userId: 'u' }],
    paireddevices: [
      { _id: 10, userId: 'u', deviceToken: 'd'.repeat(64), wrappedDEKPhonePin: 'x', wrappedDEKPhonePinIv: 'x', wrappedDEKPhonePinAuthTag: 'x', wrappedDEKPhonePinSalt: 'x', revoked: false },
      { _id: 11, userId: 'u', deviceToken: 'e'.repeat(64), wrappedDEKPhonePin: 'x', wrappedDEKPhonePinIv: 'x', wrappedDEKPhonePinAuthTag: 'x', wrappedDEKPhonePinSalt: 'x', revoked: true },
      { _id: 12, userId: 'u', tokenHash: 'already', revoked: false },
    ],
  };
  const dropped = [];
  const indexes = { pairingtokens: [{ name: 'token_1', key: { token: 1 } }, { name: 'userId_1', key: { userId: 1 } }], paireddevices: [{ name: 'deviceToken_1', key: { deviceToken: 1 } }] };
  const unsetFields = (row, spec) => { for (const key of Object.keys(spec || {})) delete row[key]; };
  const fakeCollection = (name) => ({
    findOne: async (filter) => collections[name].find((r) => String(r._id) === String(filter._id)) || null,
    insertOne: async (doc) => void collections[name].push(doc),
    indexes: async () => indexes[name] || [],
    dropIndex: async (indexName) => void dropped.push(`${name}.${indexName}`),
    deleteMany: async (filter) => {
      const missing = filter.tokenHash && filter.tokenHash.$exists === false;
      const before = collections[name].length;
      collections[name] = collections[name].filter((r) => !(missing && r.tokenHash === undefined));
      return { deletedCount: before - collections[name].length };
    },
    find: (filter) => ({ toArray: async () => collections[name].filter((r) => (filter.deviceToken ? r.deviceToken !== undefined : true)) }),
    updateOne: async (filter, update) => {
      const row = collections[name].find((r) => r._id === filter._id);
      Object.assign(row, update.$set || {});
      unsetFields(row, update.$unset);
    },
    updateMany: async (filter, update) => void collections[name].forEach((row) => unsetFields(row, update.$unset)),
  });
  Object.defineProperty(mongoose.connection, 'db', { value: { collection: fakeCollection }, configurable: true });
  const migrate = require('../utils/migrateDevices');
  await migrate();

  assert.deepEqual(dropped.sort(), ['paireddevices.deviceToken_1', 'pairingtokens.token_1']);
  assert.deepEqual(collections.pairingtokens.map((r) => r._id), [2], 'a clear pairing token is deleted (five minutes of life)');
  const [live, revoked, upgraded] = collections.paireddevices;
  assert.equal(live.tokenHash, hashToken('d'.repeat(64)), 'a live device keeps working: same raw token, now stored hashed');
  assert.equal(revoked.tokenHash, undefined, 'a revoked device keeps no token at all');
  assert.equal(upgraded.tokenHash, 'already');
  for (const row of collections.paireddevices) {
    assert.deepEqual(Object.keys(row).filter((k) => /deviceToken|wrapped/i.test(k)), [], `no clear token or PIN wrap left on ${row._id}`);
  }
  assert.equal(collections.migrations.length, 1);

  const snapshot = JSON.stringify(collections);
  await migrate();
  assert.equal(JSON.stringify(collections), snapshot, 'running again changes nothing');
  delete mongoose.connection.db;
});
