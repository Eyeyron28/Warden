// Run with: cd server && npm test   (Node's built-in test runner, no deps)
//
// Devices, the tamper-evident activity log, the suspicious-activity flags, the Overview numbers, and the
// removal of the phone vault. In-memory fakes, so every collection can be inspected.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

process.env.PUBLIC_APP_URL = 'https://warden.test';
delete process.env.VERCEL;
delete process.env.AUDIT_RETENTION_DAYS;
delete process.env.AUDIT_HMAC_KEY;
process.env.NODE_ENV = 'test';

const { encryptFile } = require('../utils/crypto');
const db = require('./helpers/fakeDb');

const world = db.createWorld();
const sameId = (a, b) => String(a) === String(b);
db.installModels(world, {
  Document: {
    aggregate: async (pipeline) => {
      const match = pipeline[0].$match;
      if (match._id?.$in) {
        const ids = match._id.$in.map(String);
        return world.tables.documents.filter((d) => ids.includes(String(d._id)) && sameId(d.userId, match.userId)).map((d) => ({ _id: d._id, size: d.encryptedBlob.length }));
      }
      return [];
    },
  },
  Share: { aggregate: async () => [] },
});
db.installRateLimit();
db.installMailer(world);

const audit = require('../utils/audit');
const { computeFlags } = require('../utils/suspicious');
const suspiciousConfig = require('../config/suspicious');
const D = require('../controllers/documents.controller');
const T = require('../controllers/trash.controller');
const S = require('../controllers/shares.controller');
const V = require('../controllers/sharedView.controller');
const security = require('../controllers/security.controller');
const insights = require('../controllers/insights.controller');
const auth = require('../controllers/auth.controller');
const { call } = db;
const { appendEvent, recordEvent, verifyChain, logFailures } = audit;

const DAY = 24 * 3600 * 1000;
const DEK = crypto.randomBytes(32);
const PASSWORD = 'Tk9$Lantern-Orbit%57';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function addUser(email = `u${Math.random().toString(16).slice(2)}@example.com`) {
  const user = { _id: db.oid(), email, emailVerified: true, failedAttempts: 0, save: async () => {} };
  world.tables.users.push(user);
  return user;
}
function addDevice(user, extra = {}) {
  const device = { _id: db.oid(), userId: user._id, deviceIdHash: crypto.randomBytes(8).toString('hex'), label: 'Chrome on Windows', firstSeenAt: new Date(), lastSeenAt: new Date(), lastCountry: null, lastCity: null, trusted: false, signedOutAt: null, ...extra };
  world.tables.devices.push(device);
  return device;
}
function addDoc(user, extra = {}) {
  const plaintext = crypto.randomBytes(300);
  const sealed = encryptFile(plaintext, DEK);
  const doc = {
    _id: db.oid(), userId: user._id, filename: 'passport.pdf', folder: 'root', mimeType: 'application/pdf', deletedAt: null,
    encryptedBlob: Buffer.from(sealed.ciphertext, 'base64'), iv: sealed.iv, authTag: sealed.authTag,
    checksum: crypto.createHash('sha256').update(plaintext).digest('hex'), plaintext,
    createdAt: new Date(), updatedAt: new Date(), viewCount: 0, downloadCount: 0, lastOpenedAt: null, save: async () => {}, ...extra,
  };
  world.tables.documents.push(doc);
  return doc;
}
const reset = () => {
  for (const name of Object.keys(world.tables)) world.tables[name] = [];
  world.mails = [];
};
const eventsOf = (user) => world.tables.auditevents.filter((e) => sameId(e.userId, user._id)).sort((a, b) => a.seq - b.seq);
const types = (user) => eventsOf(user).map((e) => e.type);
const as = (user, device = null, extra = {}) => ({ userId: user._id, dek: DEK, deviceId: device ? device._id : null, ...extra });

// ====================================================================== the chain

test('events form a chain: numbered, each signed over the one before, and the head follows', async () => {
  reset();
  const ana = addUser();
  for (let i = 0; i < 5; i += 1) await appendEvent({ userId: ana._id, type: 'login' });
  const events = eventsOf(ana);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.equal(events[0].prevHash, '');
  for (let i = 1; i < events.length; i += 1) assert.equal(events[i].prevHash, events[i - 1].hash);
  for (const e of events) assert.equal(e.hash, audit.computeHash(e.prevHash, e));
  assert.equal(ana.auditHead.seq, 5);
  assert.equal(ana.auditHead.hash, events[4].hash);
  const result = await verifyChain(ana._id);
  assert.deepEqual([result.ok, result.checked, result.firstSeq, result.lastSeq], [true, 5, 1, 5]);
});

test('verification detects an edited event, a missing event in the middle, and a cut-off end', async () => {
  const build = async () => {
    reset();
    const ana = addUser();
    for (let i = 1; i <= 8; i += 1) await appendEvent({ userId: ana._id, type: i % 2 ? 'view' : 'download', targetId: `t${i}`, country: 'PH' });
    return ana;
  };

  let ana = await build();
  assert.equal((await verifyChain(ana._id)).ok, true);

  // an edited event (any signed field), reported at THAT event's number
  for (const [field, value] of [['type', 'delete'], ['targetId', 'someone-else'], ['country', 'US'], ['at', new Date(Date.now() - 5 * DAY)], ['deviceId', db.oid()]]) {
    ana = await build();
    const victim = eventsOf(ana).find((e) => e.seq === 4);
    victim[field] = value;
    const verdict = await verifyChain(ana._id);
    assert.equal(verdict.ok, false, `editing ${field}`);
    assert.equal(verdict.brokenAtSeq, 4, `editing ${field} is reported at event #4`);
  }

  // an event deleted from the middle
  ana = await build();
  world.tables.auditevents = world.tables.auditevents.filter((e) => e.seq !== 5);
  let verdict = await verifyChain(ana._id);
  assert.deepEqual([verdict.ok, verdict.brokenAtSeq], [false, 5]);

  // the newest events removed (the end cut off)
  ana = await build();
  world.tables.auditevents = world.tables.auditevents.filter((e) => e.seq <= 5);
  verdict = await verifyChain(ana._id);
  assert.deepEqual([verdict.ok, verdict.brokenAtSeq], [false, 6]);

  // every event removed while the log was recently written
  ana = await build();
  world.tables.auditevents = [];
  verdict = await verifyChain(ana._id);
  assert.equal(verdict.ok, false);

  // an event re-signed with a different key does not pass (someone without the server key cannot forge one)
  ana = await build();
  const forged = eventsOf(ana).find((e) => e.seq === 3);
  forged.type = 'delete';
  forged.hash = crypto.createHash('sha256').update('guess').digest('hex');
  assert.equal((await verifyChain(ana._id)).ok, false);
});

test('the oldest events expiring (the 30-day TTL) is normal: what is left still verifies from its own anchor', async () => {
  reset();
  const ana = addUser();
  for (let i = 0; i < 10; i += 1) await appendEvent({ userId: ana._id, type: 'view', targetId: String(i) });
  world.tables.auditevents = world.tables.auditevents.filter((e) => e.seq > 4); // 1-4 expired
  const verdict = await verifyChain(ana._id);
  assert.deepEqual([verdict.ok, verdict.firstSeq, verdict.lastSeq, verdict.checked], [true, 5, 10, 6]);

  // everything expired and the last event is older than the retention: nothing to check, nothing wrong
  world.tables.auditevents = [];
  ana.auditHead.at = new Date(Date.now() - 40 * DAY);
  assert.equal((await verifyChain(ana._id)).ok, true);
});

test('concurrent writers cannot fork the chain: 40 simultaneous events give 40 numbers, no gaps, and it verifies', async () => {
  reset();
  const ana = addUser();
  const bob = addUser();
  await Promise.all([
    ...Array.from({ length: 40 }, (_, i) => appendEvent({ userId: ana._id, type: i % 2 ? 'view' : 'upload', targetId: String(i) })),
    ...Array.from({ length: 10 }, () => appendEvent({ userId: bob._id, type: 'login' })),
  ]);
  const seqs = eventsOf(ana).map((e) => e.seq);
  assert.deepEqual(seqs, Array.from({ length: 40 }, (_, i) => i + 1));
  assert.equal(ana.auditHead.seq, 40);
  assert.equal(ana.auditHead.hash, eventsOf(ana)[39].hash);
  assert.equal((await verifyChain(ana._id)).ok, true);
  assert.equal((await verifyChain(bob._id)).ok, true);
  assert.equal(eventsOf(bob).length, 10, "another account's chain is separate");
});

test('a writer that died between saving an event and moving the head is repaired by the next writer', async () => {
  reset();
  const ana = addUser();
  await appendEvent({ userId: ana._id, type: 'login' });
  // the crash: event 2 is saved, the head still says 1
  const head = { seq: ana.auditHead.seq, hash: ana.auditHead.hash };
  const orphan = { userId: ana._id, seq: 2, type: 'view', deviceId: null, targetId: 'x', at: new Date(), country: null };
  world.tables.auditevents.push({ _id: db.oid(), ...orphan, prevHash: head.hash, hash: audit.computeHash(head.hash, orphan), expiresAt: new Date(Date.now() + DAY) });
  assert.equal((await verifyChain(ana._id)).ok, true, 'the chain itself is valid while the head lags');
  await appendEvent({ userId: ana._id, type: 'logout' });
  assert.deepEqual(eventsOf(ana).map((e) => e.seq), [1, 2, 3]);
  assert.equal(ana.auditHead.seq, 3);
  assert.equal((await verifyChain(ana._id)).ok, true);
});

test('events hold ids, a type, a coarse country and a time - nothing else - and the TTL follows AUDIT_RETENTION_DAYS', async () => {
  reset();
  const ana = addUser();
  const at = new Date('2026-10-09T09:00:00Z');
  await appendEvent({ userId: ana._id, type: 'download', targetId: 'abc', country: 'PH', at });
  const [event] = eventsOf(ana);
  assert.deepEqual(Object.keys(event).sort(), ['_id', 'at', 'attempts', 'country', 'deviceId', 'expiresAt', 'hash', 'prevHash', 'resendCount', 'seq', 'targetId', 'type', 'userId'].sort());
  assert.equal(event.expiresAt.getTime() - event.at.getTime(), 30 * DAY, 'default: 30 days');
  process.env.AUDIT_RETENTION_DAYS = '7';
  try {
    await appendEvent({ userId: ana._id, type: 'view', at });
    assert.equal(eventsOf(ana)[1].expiresAt.getTime() - at.getTime(), 7 * DAY);
  } finally {
    delete process.env.AUDIT_RETENTION_DAYS;
  }
  const model = fs.readFileSync(path.join(__dirname, '..', 'models', 'AuditEvent.js'), 'utf8');
  assert.match(model, /index\(\{ expiresAt: 1 \}, \{ expireAfterSeconds: 0 \}\)/, 'Mongo removes events itself');
  assert.match(model, /index\(\{ userId: 1, seq: 1 \}, \{ unique: true \}\)/, 'one number per account, ever');
  const cfg = require('../utils/auditConfig');
  assert.equal(cfg.retentionDays(), 30);
  process.env.AUDIT_RETENTION_DAYS = '999';
  assert.throws(() => cfg.retentionDays(), /AUDIT_RETENTION_DAYS/);
  delete process.env.AUDIT_RETENTION_DAYS;
});

test('the country comes only from the hosting platform\'s header, never an IP; there is no city in events', () => {
  assert.equal(audit.countryFrom({ headers: { 'x-vercel-ip-country': 'ph' } }), 'PH');
  for (const bad of [undefined, '', 'PHL', 'P1', '<script>', 42]) assert.equal(audit.countryFrom({ headers: { 'x-vercel-ip-country': bad } }), null, String(bad));
  assert.equal(audit.countryFrom({ headers: {} }), null);
  assert.equal(audit.cityFrom({ headers: { 'x-vercel-ip-city': 'San%20Fernando' } }), 'San Fernando');
  assert.equal(audit.cityFrom({ headers: { 'x-vercel-ip-city': '%E0%A4%A' } }), null, 'malformed encoding is dropped');
  const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'audit.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /req\.ip|x-forwarded-for|remoteAddress|geoip|ipapi|fetch\(/i, 'no IP and no third-party lookup');
});

test('logging is best effort: a failure never throws, and it is counted', async () => {
  reset();
  const before = logFailures();
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    assert.equal(await recordEvent(null, 'login', { userId: db.oid() }), null, 'an account that does not exist');
    assert.equal(await recordEvent(null, 'login'), null, 'no user at all');
  } finally {
    console.warn = original;
  }
  assert.equal(logFailures(), before + 1);
  assert.ok(warnings.length <= 1);
  assert.ok(!warnings.join('').match(/@|[0-9a-f]{24}/), 'the warning holds no personal data');
});

// ====================================================================== every action writes exactly one event

test('each action writes exactly one event, with ids only: no file name, e-mail, purpose or IP anywhere in the log', async () => {
  reset();
  const ana = addUser('ana-private@example.com');
  const laptop = addDevice(ana);
  const doc = addDoc(ana, { filename: 'secret-passport-name.pdf' });
  const step = async (label, expected, run) => {
    const before = eventsOf(ana).length;
    await run();
    const added = eventsOf(ana).slice(before);
    assert.deepEqual(added.map((e) => e.type), expected, label);
    return added;
  };
  const me = as(ana, laptop, { headers: { 'x-vercel-ip-country': 'PH', 'user-agent': UA }, ip: '203.0.113.50' });

  const [view] = await step('view', ['view'], () => call(D.viewDocument, { ...me, params: { id: String(doc._id) }, query: {} }));
  assert.equal(String(view.deviceId), String(laptop._id));
  assert.equal(view.country, 'PH');
  assert.equal(view.targetId, String(doc._id));
  await step('download', ['download'], () => call(D.viewDocument, { ...me, params: { id: String(doc._id) }, query: { for: 'download' } }));
  await step('silent (export / preview drawing)', [], () => call(D.viewDocument, { ...me, params: { id: String(doc._id) }, query: { for: 'silent' } }));
  await step('an unknown purpose is just a view', ['view'], () => call(D.viewDocument, { ...me, params: { id: String(doc._id) }, query: { for: '<script>' } }));
  assert.deepEqual([doc.viewCount, doc.downloadCount], [2, 1], 'counters: two views, one download, silent counted nothing');
  assert.ok(doc.lastOpenedAt instanceof Date);

  await step('rename', ['rename'], () => call(D.updateDocument, { ...me, params: { id: String(doc._id) }, body: { filename: 'secret-renamed-name.pdf' } }));
  await step('an expiry-only edit is not a rename', [], () => call(D.updateDocument, { ...me, params: { id: String(doc._id) }, body: { expiryDate: null } }));
  await step('delete (to Trash)', ['delete'], () => call(D.deleteDocument, { ...me, params: { id: String(doc._id) } }));
  await step('restore', ['restore'], () => call(T.restoreItem, { ...me, body: { kind: 'file', id: String(doc._id) } }));
  await step('trash emptied', ['trash_emptied'], () => call(T.emptyTrash, { ...me }));
  await step('export (reported by the page)', ['export'], () => call(security.clientEvent, { ...me, body: { type: 'export' } }));
  await step('import (reported by the page)', ['import'], () => call(security.clientEvent, { ...me, body: { type: 'import' } }));
  assert.equal((await call(security.clientEvent, { ...me, body: { type: 'delete' } })).error.status, 400, 'a page cannot report any other kind of event');

  // sharing
  const shareDoc = addDoc(ana, { filename: 'shared-secret-name.png' });
  const [created] = await step('share created', ['share_created'], async () => {
    const made = await call(S.createShare, { ...me, params: { id: String(shareDoc._id) }, body: { durationHours: 24 } });
    assert.equal(made.status, 201);
    world.shareId = made.json.id;
    world.shareUrl = made.json.shareUrl;
  });
  assert.equal(created.targetId, world.shareId);
  // an anonymous visitor: owner's account, no device, a coarse country - and the share's open counter moves
  const visitor = { params: { shareId: world.shareId }, headers: { 'x-vercel-ip-country': 'DE', 'user-agent': 'curl/8' }, ip: '198.51.100.99' };
  const [opened] = await step('share opened (anonymous)', ['share_opened'], () => call(V.openAccess, visitor));
  assert.equal(opened.deviceId, null);
  assert.equal(opened.country, 'DE');
  const [file] = world.tables.sharedfiles;
  await step('share file downloaded (anonymous)', ['share_downloaded'], () => call(V.viewSharedFile, { ...visitor, params: { shareId: world.shareId, fileId: file.fileId } }));
  const share = world.tables.shares.find((s) => s.shareId === world.shareId);
  assert.equal(share.openCount, 1);
  assert.ok(share.lastOpenedAt instanceof Date);
  await step('share revoked', ['share_revoked'], () => call(S.revokeShare, { ...me, params: { shareId: world.shareId } }));
  await step('stop all sharing', ['shares_stopped_all'], () => call(S.stopAllShares, { ...me }));

  // nothing personal is in the log, and nothing in it carries an address
  const everything = JSON.stringify(eventsOf(ana));
  for (const secret of ['secret-passport-name', 'secret-renamed-name', 'shared-secret-name', 'ana-private', '@', '203.0.113.50', '198.51.100.99', 'curl/8', 'Chrome', 'warden.test']) {
    assert.ok(!everything.includes(secret), `the log does not contain "${secret}"`);
  }
  assert.equal((await verifyChain(ana._id)).ok, true);
});

test('account actions are logged: login, failed login, otp sent, logout, trust added and removed', async () => {
  reset();
  const ana = addUser('ana@example.com');
  const salt = require('../utils/crypto').generateSalt();
  const dek = require('../utils/crypto').generateDEK();
  const cryptoUtils = require('../utils/crypto');
  const wrapped = cryptoUtils.wrapKey(dek, cryptoUtils.deriveEncryptionKey(PASSWORD, salt));
  Object.assign(ana, {
    salt, passwordHash: cryptoUtils.hashPassword(PASSWORD, salt), wrappedDEKPassword: wrapped.wrappedKey,
    wrappedDEKPasswordIv: wrapped.iv, wrappedDEKPasswordAuthTag: wrapped.authTag,
  });
  const headers = { 'user-agent': UA, 'x-vercel-ip-country': 'PH' };

  const bad = await call(auth.unlock, { body: { email: ana.email, password: 'wrong-password-1' }, headers });
  assert.equal(bad.error.status, 401);
  const good = await call(auth.unlock, { body: { email: ana.email, password: PASSWORD }, headers });
  assert.equal(good.json.otpRequired, true);
  const code = /^(\d{6})$/m.exec(world.mails.at(-1).text)[1];
  const done = await call(auth.verifyOtp, { body: { challengeToken: good.json.challengeToken, code, trustDevice: true }, headers });
  assert.ok(done.json.sessionToken);
  const session = world.tables.sessions[0];
  await call(auth.logout, { userId: ana._id, deviceId: session.deviceId, session: { token: done.json.sessionToken }, headers });

  assert.deepEqual(types(ana), ['login_failed', 'otp_sent', 'trusted_added', 'login', 'logout']);
  assert.ok(eventsOf(ana).every((e) => e.country === 'PH'));
  assert.ok(eventsOf(ana).slice(2).every((e) => e.deviceId && sameId(e.deviceId, session.deviceId)), 'signed-in events are tied to the device');
});

// ====================================================================== devices

test('devices: a first sign-in from an unknown browser emails the owner once, with no secret in it', async () => {
  reset();
  const ana = addUser('ana@example.com');
  const { resolveDevice } = require('../utils/deviceIdentity');
  const headers = { 'user-agent': UA, 'x-vercel-ip-country': 'PH', 'x-vercel-ip-city': 'Manila' };
  const res = () => ({ cookies: {}, cookie(name, value) { this.cookies[name] = value; return this; } });

  const first = await resolveDevice({ headers }, res(), ana._id);
  assert.deepEqual([first.isNew, first.hadOtherDevices], [true, false], 'the very first browser is the baseline: no email');
  const r2 = res();
  const second = await resolveDevice({ headers: { ...headers, 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0' } }, r2, ana._id);
  assert.deepEqual([second.isNew, second.hadOtherDevices], [true, true]);
  // the same browser again (its cookie) is not new
  const again = await resolveDevice({ headers: { ...headers, cookie: `warden_did=${r2.cookies.warden_did}` } }, res(), ana._id);
  assert.equal(again.isNew, false);
  assert.equal(world.tables.devices.length, 2);
  for (const device of world.tables.devices) {
    assert.ok(!JSON.stringify(device).includes(r2.cookies.warden_did), 'only a hash of the device id is stored');
    assert.equal(device.lastCountry === 'PH' && device.lastCity === 'Manila', true);
    assert.ok(!Object.keys(device).some((k) => /ip|address/i.test(k)));
  }

  // the email, built the way the login does
  const { templates } = require('../utils/emailTemplates');
  const mail = templates.newDevice({ browser: 'Firefox', os: 'Linux', country: 'PH', city: 'Manila', when: new Date('2026-10-09T09:14:00Z') });
  assert.match(mail.text, /Device: Firefox on Linux/);
  assert.match(mail.text, /Place: Manila, Philippines/);
  assert.match(mail.text, /5:14 PM Philippine Time/);
  assert.doesNotMatch(mail.text + mail.html, /[0-9a-f]{32,}|token|key=|#k=|\d+\.\d+\.\d+\.\d+/i, 'no secret, token or IP');
  process.env.PUBLIC_APP_URL = 'https://warden.example.com';
  try {
    const links = [...templates.newDevice({ browser: 'x', os: 'y', when: new Date() }).html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(links, ['https://warden.example.com/wasnt-me'], 'one link, to a fixed page on the app, carrying nothing');
  } finally {
    process.env.PUBLIC_APP_URL = 'https://warden.test';
  }
});

test('the real login emails about a new device exactly once per device', async () => {
  reset();
  const cryptoUtils = require('../utils/crypto');
  const ana = addUser('ana@example.com');
  const salt = cryptoUtils.generateSalt();
  const dek = cryptoUtils.generateDEK();
  const wrapped = cryptoUtils.wrapKey(dek, cryptoUtils.deriveEncryptionKey(PASSWORD, salt));
  Object.assign(ana, { salt, passwordHash: cryptoUtils.hashPassword(PASSWORD, salt), wrappedDEKPassword: wrapped.wrappedKey, wrappedDEKPasswordIv: wrapped.iv, wrappedDEKPasswordAuthTag: wrapped.authTag });
  const signIn = async (browser) => {
    world.tables.ratelimits = [];
    const cookies = {};
    const headers = () => ({ 'user-agent': browser.ua, ...(browser.did ? { cookie: `warden_did=${browser.did}` } : {}) });
    const first = await call(auth.unlock, { body: { email: ana.email, password: PASSWORD }, headers: headers() });
    const code = /^(\d{6})$/m.exec(world.mails.at(-1).text)[1];
    const second = await call(auth.verifyOtp, { body: { challengeToken: first.json.challengeToken, code }, headers: headers() });
    browser.did = second.cookies.warden_did?.value || browser.did;
    return cookies;
  };
  const chrome = { ua: UA, did: null };
  const firefox = { ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0', did: null };
  const newDeviceMails = () => world.mails.filter((m) => /New device signed in/.test(m.subject)).length;

  await signIn(chrome);
  assert.equal(newDeviceMails(), 0, 'the first device is the baseline');
  await signIn(firefox);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(newDeviceMails(), 1, 'an unknown browser: one email');
  await signIn(firefox);
  await signIn(chrome);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(newDeviceMails(), 1, 'the same browsers again: no more emails');
  assert.equal(world.tables.devices.length, 2);
});

test('sign out this device ends only that device; sign out others keeps the caller; another account\'s device is a 404', async () => {
  reset();
  const ana = addUser();
  const ben = addUser();
  const here = addDevice(ana, { label: 'Chrome on Windows' });
  const phone = addDevice(ana, { label: 'Safari on iOS' });
  const bens = addDevice(ben);
  const mkSession = (user, device, hash) => world.tables.sessions.push({ _id: db.oid(), userId: user._id, deviceId: device._id, sessionIdHash: hash });
  mkSession(ana, here, 'h-here'); mkSession(ana, phone, 'h-phone'); mkSession(ben, bens, 'h-ben');
  const me = { ...as(ana, here), session: { idHash: 'h-here' } };

  const foreign = await call(security.signOutDevice, { ...me, params: { id: String(bens._id) } });
  assert.equal(foreign.error.status, 404);
  assert.equal((await call(security.signOutDevice, { ...me, params: { id: 'nope' } })).error.status, 404);
  assert.equal(world.tables.sessions.length, 3, 'nothing changed');

  const out = await call(security.signOutDevice, { ...me, params: { id: String(phone._id) } });
  assert.equal(out.json.self, false);
  assert.deepEqual(world.tables.sessions.map((s) => s.sessionIdHash).sort(), ['h-ben', 'h-here']);
  assert.ok(phone.signedOutAt instanceof Date);
  assert.deepEqual(types(ana), ['device_signed_out']);
  assert.equal(String(eventsOf(ana)[0].targetId), String(phone._id));

  mkSession(ana, phone, 'h-phone2');
  const others = await call(security.signOutOthers, { ...me, body: {} });
  assert.equal(others.json.devices, 1);
  assert.deepEqual(world.tables.sessions.map((s) => s.sessionIdHash).sort(), ['h-ben', 'h-here'], 'the caller\'s session and ben\'s remain');
  assert.equal((await call(security.signOutOthers, { ...me, body: { forgetTrusted: 'yes' } })).error.status, 400);

  const listed = await call(security.listDevices, { ...me });
  assert.deepEqual(listed.json.devices.map((d) => [d.label, d.current]), [['Chrome on Windows', true], ['Safari on iOS', false]]);
  assert.ok(!JSON.stringify(listed.json).match(/deviceIdHash|tokenHash/), 'nothing replayable leaves the server');
});

// ====================================================================== the timeline and its flags

const ev = (seq, type, minutes, extra = {}) => ({ seq, type, at: new Date(Date.UTC(2026, 9, 1, 12, 0) + minutes * 60000), ...extra });

test('suspicious: a sign-in from a new country (only once there is an earlier login to compare)', () => {
  const flags = computeFlags([ev(1, 'login', 0, { country: 'PH' }), ev(2, 'login', 5, { country: 'PH' }), ev(3, 'login', 9, { country: 'JP' }), ev(4, 'login', 12, { country: 'JP' }), ev(5, 'login', 14, { country: null })]);
  assert.deepEqual([...flags.keys()], [3]);
  assert.deepEqual(flags.get(3), ['new_country']);
  assert.equal(computeFlags([ev(1, 'login', 0, { country: 'JP' })]).size, 0, 'a first login is not "new"');
});

test('suspicious: 10 downloads in 5 minutes is a burst; 9, or 10 spread over longer, is not', () => {
  assert.equal(suspiciousConfig.downloadBurst.count, 10);
  assert.equal(suspiciousConfig.downloadBurst.windowMs, 5 * 60 * 1000);
  const burst = Array.from({ length: 10 }, (_, i) => ev(i + 1, 'download', i * 0.5));
  const flagged = computeFlags(burst);
  assert.equal(flagged.size, 10);
  assert.ok([...flagged.values()].every((f) => f.includes('download_burst')));
  assert.equal(computeFlags(burst.slice(0, 9)).size, 0, 'nine is fine');
  const slow = Array.from({ length: 10 }, (_, i) => ev(i + 1, 'download', i * 1.2)); // 10 over 10.8 minutes
  assert.equal(computeFlags(slow).size, 0);
  const edge = Array.from({ length: 10 }, (_, i) => ev(i + 1, 'download', i * (5 / 9))); // exactly 5 minutes first to last
  assert.equal(computeFlags(edge).size, 10, 'exactly five minutes still counts');
  const mixed = [...Array.from({ length: 9 }, (_, i) => ev(i + 1, 'download', i)), ev(10, 'view', 9.5)];
  assert.equal(computeFlags(mixed).size, 0, 'views are not downloads');
});

test('suspicious: failed attempts followed by a success, and a signed-out device signing in again', () => {
  const failed = computeFlags([ev(1, 'login_failed', 0), ev(2, 'login_failed', 1), ev(3, 'login_failed', 2), ev(4, 'login', 3)]);
  assert.deepEqual([...failed.keys()].sort(), [1, 2, 3, 4]);
  assert.ok(failed.get(4).includes('failed_then_success'));
  assert.equal(computeFlags([ev(1, 'login_failed', 0), ev(2, 'login_failed', 1), ev(3, 'login', 2)]).size, 0, 'two failures are normal');
  assert.equal(computeFlags([ev(1, 'login_failed', 0), ev(2, 'login_failed', 1), ev(3, 'login_failed', 2), ev(4, 'login', 40)]).size, 0, 'the failures were too long ago');
  assert.equal(computeFlags([ev(1, 'login_failed', 0), ev(2, 'login_failed', 1), ev(3, 'login', 2), ev(4, 'login_failed', 3), ev(5, 'login', 4)]).size, 0, 'a success in between resets the count');

  const D1 = 'dev-1';
  const signedOut = computeFlags([ev(1, 'login', 0, { deviceId: D1 }), ev(2, 'device_signed_out', 5, { targetId: D1 }), ev(3, 'login', 9, { deviceId: D1 }), ev(4, 'login', 12, { deviceId: D1 })]);
  assert.deepEqual([...signedOut.keys()], [3], 'only the first sign-in after being signed out');
  assert.deepEqual(signedOut.get(3), ['signed_out_device_active']);
  assert.equal(computeFlags([ev(1, 'device_signed_out', 5, { targetId: D1 }), ev(2, 'login', 9, { deviceId: 'another' })]).size, 0);
  for (const key of ['newCountry', 'downloadBurst', 'failedThenSuccess', 'signedOutDeviceActive', 'bannerLookbackMs']) assert.ok(key in suspiciousConfig, `${key} is in the one config file`);
});

test('the timeline: newest first, 50 per page with a cursor, filters, names looked up now, only your own events', async () => {
  reset();
  const ana = addUser();
  const ben = addUser();
  const laptop = addDevice(ana, { label: 'Chrome on Windows' });
  const phone = addDevice(ana, { label: 'Safari on iOS' });
  const gone = addDoc(ana, { filename: 'will-be-deleted.pdf' });
  const kept = addDoc(ana, { filename: 'kept.pdf' });
  const base = Date.now() - 20 * DAY;
  for (let i = 0; i < 130; i += 1) {
    const type = ['view', 'download', 'login', 'share_created'][i % 4];
    await appendEvent({
      userId: ana._id, type, deviceId: i % 2 ? laptop._id : phone._id, country: 'PH', at: new Date(base + i * 3600000),
      targetId: type === 'share_created' ? 'a'.repeat(32) : type === 'login' ? null : String(i % 8 === 0 ? gone._id : kept._id),
    });
  }
  await appendEvent({ userId: ben._id, type: 'download', targetId: String(kept._id) });
  world.tables.documents = world.tables.documents.filter((d) => !sameId(d._id, gone._id)); // permanently deleted since

  const page = (query, device = laptop) => call(security.listActivity, { ...as(ana, device), query });
  const everything = async (query) => {
    const rows = [];
    let before;
    do {
      // eslint-disable-next-line no-await-in-loop
      const result = await page({ ...query, ...(before ? { before: String(before) } : {}) });
      rows.push(...result.json.events);
      before = result.json.nextBefore;
    } while (before);
    return rows;
  };
  const first = await page({});
  assert.equal(first.json.events.length, 50);
  assert.equal(first.json.events[0].seq, 130, 'newest first');
  assert.equal(first.json.nextBefore, first.json.events[49].seq);
  const second = await page({ before: String(first.json.nextBefore) });
  assert.equal(second.json.events[0].seq, first.json.events[49].seq - 1, 'the next page continues exactly where the last ended');
  const third = await page({ before: String(second.json.nextBefore) });
  assert.equal(third.json.events.length, 30);
  assert.equal(third.json.nextBefore, null);

  const row = first.json.events.find((e) => e.type === 'view');
  assert.ok(row.device.label && typeof row.device.current === 'boolean' && row.countryName === 'Philippines');
  assert.ok(first.json.events.some((e) => e.target.kind === 'file' && e.target.gone === true && e.target.name === null), 'a file that no longer exists shows as deleted');
  assert.ok(first.json.events.some((e) => e.target.kind === 'file' && e.target.name === 'kept.pdf'));
  assert.ok(first.json.events.some((e) => e.target.kind === 'share' && e.target.gone === true), 'a share link that is gone');
  assert.ok(!JSON.stringify(eventsOf(ana)).includes('kept.pdf'), 'the names are not in the log');

  const account = await everything({ group: 'account' });
  assert.ok(account.length > 0 && account.every((e) => e.type === 'login'));
  const sharing = await everything({ group: 'sharing' });
  assert.ok(sharing.length > 0 && sharing.every((e) => e.type === 'share_created'));
  const vault = await everything({ group: 'vault' });
  assert.ok(vault.length > 0 && vault.every((e) => ['view', 'download'].includes(e.type)));
  assert.equal(account.length + sharing.length + vault.length, 130, 'the three groups together are everything');
  const onPhone = await everything({ device: String(phone._id) });
  assert.ok(onPhone.every((e) => e.device.id === String(phone._id)) && onPhone.length === 65);
  const ranged = await everything({ from: new Date(base + 10 * 3600000).toISOString(), to: new Date(base + 19 * 3600000).toISOString() });
  assert.deepEqual(ranged.map((e) => e.seq).sort((a, b) => a - b), Array.from({ length: 10 }, (_, i) => 11 + i));
  assert.equal((await page({ limit: '1000' })).json.events.length, 50, 'a page is never longer than 50');

  assert.equal((await page({ group: 'nope' })).error.status, 400);
  assert.equal((await page({ device: 'nope' })).error.status, 400);
  assert.equal((await page({ before: '0' })).error.status, 400);
  assert.equal((await page({ from: 'yesterday' })).error.status, 400);

  // nobody else's events are readable, and there is no way to edit or delete an event
  const bens = await call(security.listActivity, { ...as(ben), query: { limit: '200' } });
  assert.equal(bens.json.events.length, 1);
  assert.equal(bens.json.events[0].device, null);
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'security.routes.js'), 'utf8');
  assert.doesNotMatch(routes, /router\.(put|patch|delete)\(/, 'no route changes or removes an event');
  assert.match(routes, /router\.use\(requireSession/);
});

test('the banner counts flagged events from the last 7 days, and Verify log reports the chain', async () => {
  reset();
  const ana = addUser();
  const laptop = addDevice(ana);
  for (let i = 0; i < 12; i += 1) await appendEvent({ userId: ana._id, type: 'download', deviceId: laptop._id, targetId: String(i), at: new Date(Date.now() - 60000 + i * 1000) });
  await appendEvent({ userId: ana._id, type: 'login', deviceId: laptop._id, country: 'PH', at: new Date(Date.now() - 20 * DAY) });
  const listed = await call(security.listActivity, { ...as(ana, laptop), query: {} });
  assert.equal(listed.json.flaggedRecent, 12, 'the burst of 12 downloads');
  assert.ok(listed.json.events.filter((e) => e.type === 'download').every((e) => e.flags.some((f) => f.code === 'download_burst')));
  assert.equal(listed.json.retentionDays, 30);

  const intact = await call(security.verifyLog, { ...as(ana, laptop) });
  assert.equal(intact.json.ok, true);
  eventsOf(ana).find((e) => e.seq === 7).type = 'delete';
  const broken = await call(security.verifyLog, { ...as(ana, laptop) });
  assert.deepEqual([broken.json.ok, broken.json.brokenAtSeq], [false, 7]);
  assert.match(broken.json.reason, /changed/);
});

// ====================================================================== overview

test('Overview: counters, trashed files left out, stale files at exactly 180 days, frequently used, link statistics', async () => {
  reset();
  const ana = addUser();
  const ben = addUser();
  const now = Date.now();
  const mk = (name, extra) => addDoc(ana, { filename: name, ...extra });
  const popular = mk('popular.pdf', { viewCount: 9, downloadCount: 1, lastOpenedAt: new Date(now - 1 * DAY) });
  const downloaded = mk('downloaded.pdf', { viewCount: 1, downloadCount: 7, lastOpenedAt: new Date(now - 2 * DAY) });
  mk('trashed.pdf', { viewCount: 50, downloadCount: 50, lastOpenedAt: new Date(now), deletedAt: new Date() });
  addDoc(ben, { filename: 'bens.pdf', viewCount: 99, lastOpenedAt: new Date() });
  const fresh = mk('fresh.pdf', { createdAt: new Date(now - 10 * DAY) });
  const edge179 = mk('idle-179.pdf', { createdAt: new Date(now - 179 * DAY) });
  const edge180 = mk('idle-180.pdf', { createdAt: new Date(now - 180 * DAY - 1000) });
  const openedLongAgo = mk('opened-long-ago.pdf', { createdAt: new Date(now - 400 * DAY), lastOpenedAt: new Date(now - 181 * DAY), viewCount: 1 });
  const createdOldButOpened = mk('old-but-opened-recently.pdf', { createdAt: new Date(now - 400 * DAY), lastOpenedAt: new Date(now - 3 * DAY), viewCount: 1 });

  const overview = (await call(insights.getOverview, { ...as(ana) })).json;
  assert.equal(overview.totals.files, 7, 'trashed and other accounts\' files are not counted');
  assert.deepEqual(overview.mostViewed.map((d) => d.filename).slice(0, 2), ['popular.pdf', 'downloaded.pdf'].slice(0, 1).concat(overview.mostViewed[1].filename));
  assert.equal(overview.mostViewed[0].viewCount, 9);
  assert.equal(overview.mostDownloaded[0].filename, 'downloaded.pdf');
  assert.ok(!JSON.stringify(overview).includes('trashed.pdf') && !JSON.stringify(overview).includes('bens.pdf'));
  assert.ok(overview.recentlyOpened.length <= 10 && overview.recentlyOpened[0].filename === 'popular.pdf');

  const stale = (await call(insights.getStale, { ...as(ana) })).json;
  assert.deepEqual(stale.items.map((d) => d.filename).sort(), ['idle-180.pdf', 'opened-long-ago.pdf'], 'idle 180+ days: by last open, else by creation');
  assert.ok(!stale.items.some((d) => d.filename === edge179.filename || d.filename === fresh.filename || d.filename === createdOldButOpened.filename));
  assert.equal(overview.stale.count, 2);
  assert.ok(stale.items.every((d) => d.idleDays >= 180));
  assert.deepEqual(insights.staleOf([{ ...edge179 }, { ...edge180 }], new Date(now)).map((d) => d.filename), ['idle-180.pdf']);
  // the boundary itself: exactly 180 days idle counts
  const exactly = { _id: 'x', filename: 'exact', createdAt: new Date(now - 180 * DAY) };
  assert.equal(insights.staleOf([exactly], new Date(now)).length, 1);
  assert.equal(insights.staleOf([{ ...exactly, createdAt: new Date(now - 180 * DAY + 1) }], new Date(now)).length, 0);

  // frequently used comes from recent views in the log
  for (let i = 0; i < 4; i += 1) await appendEvent({ userId: ana._id, type: 'view', targetId: String(downloaded._id) });
  for (let i = 0; i < 2; i += 1) await appendEvent({ userId: ana._id, type: 'view', targetId: String(popular._id) });
  await appendEvent({ userId: ana._id, type: 'view', targetId: String(world.tables.documents.find((d) => d.filename === 'trashed.pdf')._id) });
  await appendEvent({ userId: ana._id, type: 'view', at: new Date(now - 40 * DAY), targetId: String(fresh._id) });
  const frequent = (await call(insights.getFrequent, { ...as(ana) })).json.items;
  assert.deepEqual(frequent.map((d) => [d.filename, d.opens]), [['downloaded.pdf', 4], ['popular.pdf', 2]], 'ranked by recent opens; trashed and old ones left out');
  assert.deepEqual((await call(insights.getFrequent, { ...as(ben) })).json.items.map((d) => d.filename), ['bens.pdf'], "ben sees only his own (from his counters, as he has no log events)");
  reset();
  assert.deepEqual((await call(insights.getFrequent, { ...as(addUser()) })).json.items, [], 'hidden when empty');
});

test('Overview: link statistics come from the share records and hold no recipient identity', async () => {
  reset();
  const ana = addUser();
  const d1 = addDoc(ana, { filename: 'link-one.pdf' });
  const d2 = addDoc(ana, { filename: 'link-two.pdf' });
  const now = Date.now();
  const share = (id, extra) => world.tables.shares.push({ _id: db.oid(), shareId: id, ownerUserId: ana._id, sourceDocumentIds: [d1._id], fileCount: 1, ready: true, openCount: 0, lastOpenedAt: null, expiresAt: new Date(now + 20 * DAY), recipientEmail: null, ...extra });
  share('a'.repeat(32), { openCount: 5, lastOpenedAt: new Date(now - DAY), recipientEmail: 'private-person@example.com' });
  share('b'.repeat(32), { openCount: 2, sourceDocumentIds: [d2._id] });
  share('c'.repeat(32), { expiresAt: new Date(now + 3 * DAY) });
  share('d'.repeat(32), { expiresAt: new Date(now + 3 * DAY), openCount: 1 });
  share('e'.repeat(32), { expiresAt: new Date(now - DAY), openCount: 9 }); // expired: not active
  share('f'.repeat(32), { ready: false, openCount: 9 }); // still being locked with a password: not active
  const stats = (await call(insights.getOverview, { ...as(ana) })).json.sharing;
  assert.deepEqual([stats.active, stats.neverOpened, stats.expiringSoon], [4, 1, 2]);
  assert.deepEqual([stats.mostOpened.openCount, stats.mostOpened.name], [5, 'link-one.pdf']);
  assert.ok(!JSON.stringify(stats).includes('private-person'), 'no recipient identity');
});

// ====================================================================== the phone vault is gone

test('the old phone, pairing, sync and devices URLs answer 410 and nothing else', async () => {
  const express = require('express');
  const removed = require('../routes/removed.routes');
  const app = express();
  app.use('/api', removed);
  app.use((req, res) => res.status(404).json({ reached: 'the real routes' }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    for (const [method, url] of [
      ['POST', '/api/pair/init'], ['POST', '/api/pair/complete'], ['GET', '/api/pair/status/abc'], ['POST', '/api/pair/code'],
      ['POST', '/api/pairing/init'], ['GET', '/api/sync/documents'], ['POST', '/api/sync/pull'], ['POST', '/api/sync/push'],
      ['GET', '/api/devices'], ['POST', '/api/devices/123/revoke'],
      ['POST', '/api/auth/recover-via-phone/init'], ['GET', '/api/auth/recover-via-phone/status/x'],
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, { method });
      assert.equal(response.status, 410, `${method} ${url}`);
      assert.ok((await response.json()).error.message.length > 20);
    }
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/security/devices`)).status, 404, 'the new device API is not caught by the 410s');
  } finally {
    server.close();
  }
});

test('no pairing, PIN, phone sync or offline-vault code remains in the server or the client', () => {
  const root = path.join(__dirname, '..', '..');
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git', 'test', 'test-results', 'certs', '.playwright-mcp'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|jsx|mjs|cjs|css)$/.test(entry.name) && !/\.test\.(js|jsx|mjs)$/.test(entry.name)) {
        const rel = path.relative(root, full).replace(/\\/g, '/');
        // these two only talk ABOUT what was removed
        if (['server/routes/removed.routes.js', 'server/utils/migrateRemovePhone.js'].includes(rel)) continue;
        const text = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        if (/PairedDevice|PairingToken|RecoveryRequestToken|requireDeviceAuth|requireSessionOrDeviceAuth|deviceToken|wrappedDEKPhonePin|PhoneVault|PairPage|PhoneRecovery|localVault|phoneSync|pinRules|pinLockout|\/api\/sync|\/api\/pair\b|recover-via-phone|warden-local|indexedDB|IndexedDB|pair-device|devicePaired|pairDeviceCode/.test(text)) hits.push(rel);
      }
    }
  };
  walk(path.join(root, 'server'));
  walk(path.join(root, 'client', 'src'));
  walk(path.join(root, 'scripts'));
  assert.deepEqual(hits, []);
  for (const gone of [
    'server/controllers/pairing.controller.js', 'server/controllers/sync.controller.js', 'server/models/PairedDevice.js', 'server/models/PairingToken.js',
    'client/src/pages/PhoneVault.jsx', 'client/src/pages/PairPage.jsx', 'client/src/services/localVault.js', 'client/src/services/localCrypto.js',
  ]) assert.equal(fs.existsSync(path.join(root, gone)), false, gone);
  // the service worker never touches /api (no cached authenticated content), and the manifest carries none
  const worker = fs.readFileSync(path.join(root, 'client', 'public', 'service-worker.js'), 'utf8');
  assert.match(worker, /BYPASS_PREFIXES = \['\/api\/'/);
  assert.match(worker, /BYPASS_PREFIXES\.some\(\(prefix\) => url\.pathname\.startsWith\(prefix\)\)\) return;/);
});

test('the removal migration is idempotent and clears everything the phone vault stored', async () => {
  const mongoose = require('mongoose');
  const migrate = require('../utils/migrateRemovePhone');
  const collections = {
    migrations: [],
    paireddevices: [{ _id: 1 }], pairingtokens: [{ _id: 2 }], recoveryrequesttokens: [{ _id: 3 }],
    otpchallenges: [{ _id: 4, purpose: 'pair-device' }, { _id: 5, purpose: 'login' }],
    ratelimits: [{ _id: 6, bucket: 'pair-owner' }, { _id: 7, bucket: 'pair-complete-account' }, { _id: 8, bucket: 'pair-complete' }, { _id: 9, bucket: 'login' }],
    documents: [{ _id: 10, clientId: 'phone-1', filename: 'kept' }],
  };
  const dropped = [];
  const indexes = { documents: [{ name: 'userId_1_clientId_1', key: { userId: 1, clientId: 1 } }, { name: '_id_', key: { _id: 1 } }] };
  const collection = (name) => ({
    findOne: async (filter) => (collections[name] || []).find((row) => row._id === filter._id) || null,
    insertOne: async (doc) => void collections[name].push(doc),
    drop: async () => { delete collections[name]; },
    deleteMany: async (filter) => {
      collections[name] = collections[name].filter((row) => {
        if (filter.purpose) return row.purpose !== filter.purpose;
        if (filter.bucket) return !filter.bucket.$in.includes(row.bucket);
        return true;
      });
    },
    updateMany: async (filter, update) => void collections[name].forEach((row) => { for (const key of Object.keys(update.$unset || {})) delete row[key]; }),
    indexes: async () => indexes[name] || [],
    dropIndex: async (indexName) => void dropped.push(indexName),
  });
  Object.defineProperty(mongoose.connection, 'db', {
    value: { collection, listCollections: () => ({ toArray: async () => Object.keys(collections).map((n) => ({ name: n })) }) },
    configurable: true,
  });
  try {
    await migrate();
    assert.deepEqual(Object.keys(collections).sort(), ['documents', 'migrations', 'otpchallenges', 'ratelimits']);
    assert.deepEqual(collections.otpchallenges.map((r) => r._id), [5], 'only the pairing codes went');
    assert.deepEqual(collections.ratelimits.map((r) => r._id), [9], 'only the pairing counters went');
    assert.equal(collections.documents[0].clientId, undefined);
    assert.equal(collections.documents[0].filename, 'kept');
    assert.deepEqual(dropped, ['userId_1_clientId_1']);
    assert.equal(collections.migrations.length, 1);
    const snapshot = JSON.stringify(collections);
    await migrate();
    assert.equal(JSON.stringify(collections), snapshot, 'a second run changes nothing');
  } finally {
    delete mongoose.connection.db;
  }
});

test('deleting an account or wiping the vault removes the account\'s devices and events', async () => {
  reset();
  const ana = addUser();
  const ben = addUser();
  for (const user of [ana, ben]) {
    addDevice(user);
    await appendEvent({ userId: user._id, type: 'login' });
  }
  const { deleteAccountData } = require('../utils/accountDeletion');
  const { wipeVault } = require('../utils/accountReset');
  await wipeVault(ana._id);
  assert.equal(world.tables.devices.filter((d) => sameId(d.userId, ana._id)).length, 0);
  assert.equal(eventsOf(ana).length, 0);
  assert.deepEqual([ana.auditHead.seq, ana.auditHead.hash], [0, ''], 'a wipe starts a fresh chain');
  await appendEvent({ userId: ana._id, type: 'password_changed' });
  assert.equal((await verifyChain(ana._id)).ok, true);

  await deleteAccountData(ben._id, { transaction: false });
  assert.equal(world.tables.devices.filter((d) => sameId(d.userId, ben._id)).length, 0);
  assert.equal(eventsOf(ben).length, 0);
  assert.equal(world.tables.devices.length, 0);
});
