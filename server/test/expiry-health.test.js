// Run with: cd server && npm test
//
// Document expiry + reminders, the vault health score, and the purpose on share links (server side: the purpose
// is never stored in the clear and never reaches an audit event, a log or an email).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.PUBLIC_APP_URL = 'https://warden.test';
delete process.env.VERCEL;
process.env.NODE_ENV = 'test';

const { encryptFile } = require('../utils/crypto');
const shareCrypto = require('../utils/shareCrypto');
const db = require('./helpers/fakeDb');

const world = db.createWorld();
db.installModels(world, {
  Document: {
    aggregate: async (pipeline) => {
      const ids = pipeline[0].$match._id.$in.map(String);
      return world.tables.documents
        .filter((d) => ids.includes(String(d._id)) && String(d.userId) === String(pipeline[0].$match.userId))
        .map((d) => ({ _id: d._id, size: d.encryptedBlob.length }));
    },
  },
  Share: {
    aggregate: async () => [],
  },
});
// The real rate limiter is wanted while the account routes are built (they create limiters); the stub comes after.
const accountRouter = require('../routes/account.routes');
db.installRateLimit();
db.installMailer(world);

const { THRESHOLDS, parseExpiryInput, daysUntil, dueThreshold, thresholdsCovered, expiryStatus } = require('../utils/docExpiry');
const { computeVaultHealth, WEIGHTS } = require('../utils/vaultHealth');
const { runReminders } = require('../utils/reminders');
const { createShare, listAllShares } = require('../controllers/shares.controller');
const { viewSharedManifest } = require('../controllers/sharedView.controller');
const { updateDocument, listExpiringDocuments } = require('../controllers/documents.controller');
const { getHealth } = require('../controllers/health.controller');
const { deletePermanently, emptyTrash } = require('../utils/trash');
const { deleteAccountData } = require('../utils/accountDeletion');
const cronRouter = require('../routes/cron.routes');
const requireSession = require('../middleware/requireSession');
const { call } = db;

const DEK = crypto.randomBytes(32);
const ALICE = db.oid();
const BOB = db.oid();
const NOW = new Date('2026-10-09T01:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const dayStr = (offset, from = NOW) => new Date(from.getTime() + offset * DAY).toISOString().slice(0, 10);

function reset() {
  for (const name of Object.keys(world.tables)) world.tables[name] = [];
  world.mails = [];
  world.tables.users.push({ _id: ALICE, email: 'alice@example.com', emailVerified: true });
  world.tables.users.push({ _id: BOB, email: 'bob@example.com', emailVerified: true });
}

function addDocument({ owner = ALICE, filename = 'passport.png', expires = null, deletedAt = null, mimeType = 'image/png' } = {}) {
  const plaintext = crypto.randomBytes(256);
  const sealed = encryptFile(plaintext, DEK);
  const doc = {
    _id: db.oid(), userId: owner, filename, mimeType, folder: 'root',
    encryptedBlob: Buffer.from(sealed.ciphertext, 'base64'), iv: sealed.iv, authTag: sealed.authTag,
    checksum: crypto.createHash('sha256').update(plaintext).digest('hex'),
    docExpiresAt: expires ? parseExpiryInput(expires) : null,
    deletedAt, purgeAt: deletedAt ? new Date(deletedAt.getTime() + 30 * DAY) : null, trashBatchId: null,
    async save() { return this; },
  };
  world.tables.documents.push(doc);
  return doc;
}

// ---------- docExpiry ----------
test('expiry dates: real calendar days only, compared by UTC day, thresholds are the smallest reached', () => {
  assert.equal(parseExpiryInput('2027-03-05').toISOString(), '2027-03-05T00:00:00.000Z');
  for (const bad of ['2027-02-30', '2027-13-01', '27-03-05', '', null, 5, '1999-01-01', '2101-01-01', '2027-03-05T10:00:00Z']) {
    assert.equal(parseExpiryInput(bad), null, String(bad));
  }
  assert.equal(daysUntil(parseExpiryInput('2026-10-15'), NOW), 6);
  assert.equal(daysUntil(parseExpiryInput('2026-10-09'), NOW), 0);
  assert.equal(daysUntil(parseExpiryInput('2026-10-08'), NOW), -1);
  assert.deepEqual([...THRESHOLDS], [60, 30, 7, 0]);
  assert.equal(dueThreshold(61), null);
  assert.equal(dueThreshold(60), 60);
  assert.equal(dueThreshold(45), 60);
  assert.equal(dueThreshold(30), 30);
  assert.equal(dueThreshold(6), 7);
  assert.equal(dueThreshold(0), 0);
  assert.equal(dueThreshold(-20), 0);
  assert.deepEqual(thresholdsCovered(7), [60, 30, 7]);
  assert.equal(expiryStatus(parseExpiryInput('2026-10-08'), NOW), 'expired');
  assert.equal(expiryStatus(parseExpiryInput('2026-12-08'), NOW), 'soon');
  assert.equal(expiryStatus(parseExpiryInput('2026-12-09'), NOW), 'ok', '61 days off');
  assert.equal(expiryStatus(null, NOW), null);
});

// ---------- setting the date ----------
test('setting, changing and clearing an expiry date: validated, evented by file id only, owner only', async () => {
  reset();
  const doc = addDocument({ filename: 'secret-passport-scan.png' });
  const req = (body, userId = ALICE) => ({ userId, dek: DEK, params: { id: String(doc._id) }, body });

  const bad = await call(updateDocument, req({ docExpiresAt: '2027-02-30' }));
  assert.equal(bad.error?.status, 400);
  const bad2 = await call(updateDocument, req({ docExpiresAt: 12345 }));
  assert.equal(bad2.error?.status, 400);
  const stranger = await call(updateDocument, req({ docExpiresAt: '2027-03-05' }, BOB));
  assert.equal(stranger.error?.status, 404);

  const set = await call(updateDocument, req({ docExpiresAt: '2027-03-05' }));
  assert.equal(set.status, 200);
  assert.equal(new Date(set.json.docExpiresAt).toISOString(), '2027-03-05T00:00:00.000Z');
  const again = await call(updateDocument, req({ docExpiresAt: '2027-03-05' }));
  assert.equal(again.status, 200);
  await call(updateDocument, req({ docExpiresAt: null }));

  const types = world.tables.auditevents.map((e) => e.type);
  assert.deepEqual(types, ['expiry_set', 'expiry_cleared'], 'an unchanged date records nothing');
  const logged = JSON.stringify(world.tables.auditevents);
  assert.ok(!logged.includes('secret-passport-scan') && !logged.includes('2027-03-05'), 'the event holds the file id only');
});

// ---------- reminders ----------
test('a file 6 days from expiry: one email however many times the job runs; no file name in it', async () => {
  reset();
  addDocument({ filename: 'visa-application-form.png', expires: dayStr(6) });
  const first = await runReminders({ now: NOW });
  const second = await runReminders({ now: NOW });
  const third = await runReminders({ now: new Date(NOW.getTime() + 60 * 1000) });
  assert.equal(first.emails, 1);
  assert.equal(second.emails, 0);
  assert.equal(third.emails, 0);
  assert.equal(world.mails.length, 1);
  const mail = world.mails[0];
  assert.equal(mail.to, 'alice@example.com');
  assert.ok(!(mail.text + mail.html + mail.subject).toLowerCase().includes('visa-application'), 'no file name');
  assert.match(mail.text, /Documents expiring soon/);
  assert.match(mail.text, /Expire within 7 days: 1/);
  // the 60 and 30 thresholds were behind it already: marked, not emailed
  const rows = world.tables.reminderlogs;
  assert.deepEqual(rows.map((r) => r.threshold).sort((a, b) => b - a), [60, 30, 7]);
  assert.deepEqual(rows.filter((r) => r.sent).map((r) => r.threshold), [7]);
});

test('thresholds fire one at a time as the date approaches, each once', async () => {
  reset();
  addDocument({ expires: dayStr(50) });
  const at = (offset) => new Date(NOW.getTime() + offset * DAY);
  assert.equal((await runReminders({ now: NOW })).emails, 1); // 60
  assert.equal((await runReminders({ now: at(10) })).emails, 0); // 40 days left: nothing new
  assert.equal((await runReminders({ now: at(20) })).emails, 1); // 30
  assert.equal((await runReminders({ now: at(21) })).emails, 0);
  assert.equal((await runReminders({ now: at(43) })).emails, 1); // 7
  assert.equal((await runReminders({ now: at(50) })).emails, 1); // the day itself
  assert.equal((await runReminders({ now: at(70) })).emails, 0); // expired long ago, already told
  assert.equal(world.mails.length, 4);
});

test('one email per account per run, merging thresholds and files; each account only hears about its own', async () => {
  reset();
  addDocument({ expires: dayStr(3) });
  addDocument({ expires: dayStr(20) });
  addDocument({ expires: dayStr(0) });
  addDocument({ expires: dayStr(-9) });
  addDocument({ owner: BOB, expires: dayStr(40) });
  const result = await runReminders({ now: NOW });
  assert.equal(result.emails, 2);
  const alice = world.mails.find((m) => m.to === 'alice@example.com');
  const bob = world.mails.find((m) => m.to === 'bob@example.com');
  assert.match(alice.text, /4 documents/);
  assert.match(alice.text, /Expired or expiring today: 2/);
  assert.match(alice.text, /Expire within 7 days: 1/);
  assert.match(alice.text, /Expire within 30 days: 1/);
  assert.match(bob.text, /1 document /);
});

test('a changed expiry date re-arms the reminders', async () => {
  reset();
  const doc = addDocument({ expires: dayStr(6) });
  assert.equal((await runReminders({ now: NOW })).emails, 1);
  assert.equal((await runReminders({ now: NOW })).emails, 0);
  // same date saved again changes nothing
  await call(updateDocument, { userId: ALICE, dek: DEK, params: { id: String(doc._id) }, body: { docExpiresAt: dayStr(6) } });
  assert.equal((await runReminders({ now: NOW })).emails, 0);
  // renewed to a new date, then close to it again
  await call(updateDocument, { userId: ALICE, dek: DEK, params: { id: String(doc._id) }, body: { docExpiresAt: dayStr(5) } });
  assert.equal(world.tables.reminderlogs.length, 0, 'rows cleared');
  assert.equal((await runReminders({ now: NOW })).emails, 1);
});

test('trashed files, other people, opted-out and unverified accounts, and far-off dates never remind', async () => {
  reset();
  addDocument({ expires: dayStr(2), deletedAt: new Date(NOW.getTime() - DAY) }); // in Trash
  addDocument({ expires: dayStr(200) }); // far away
  addDocument({}); // no date
  addDocument({ owner: BOB, expires: dayStr(2) });
  world.tables.users.find((u) => String(u._id) === String(BOB)).expiryReminders = false;
  const carol = db.oid();
  world.tables.users.push({ _id: carol, email: 'carol@example.com', emailVerified: false });
  addDocument({ owner: carol, expires: dayStr(2) });
  const result = await runReminders({ now: NOW });
  assert.equal(result.emails, 0);
  assert.equal(result.skippedOptOut, 1);
  assert.equal(world.mails.length, 0);
  assert.equal(world.tables.reminderlogs.length, 0, 'an opted-out account is not marked: turning it back on still reminds');
  world.tables.users.find((u) => String(u._id) === String(BOB)).expiryReminders = true;
  assert.equal((await runReminders({ now: NOW })).emails, 1);
});

test('a failed send releases the claim so the next run tries again; a run stops at its email cap and says so', async () => {
  reset();
  addDocument({ expires: dayStr(5) });
  world.failMail = true;
  const failed = await runReminders({ now: NOW });
  world.failMail = false;
  assert.equal(failed.failed, 1);
  assert.equal(world.tables.reminderlogs.filter((r) => r.sent).length, 0);
  assert.equal((await runReminders({ now: NOW })).emails, 1);

  reset();
  for (let i = 0; i < 3; i += 1) {
    const id = db.oid();
    world.tables.users.push({ _id: id, email: `u${i}@example.com`, emailVerified: true });
    addDocument({ owner: id, expires: dayStr(5) });
  }
  const capped = await runReminders({ now: NOW, maxEmails: 2 });
  assert.equal(capped.emails, 2);
  assert.equal(capped.remaining, true);
  const rest = await runReminders({ now: NOW, maxEmails: 2 });
  assert.equal(rest.emails, 1, 'the next run picks up what is left, and nobody twice');
  assert.equal(world.mails.length, 3);
});

test('the job logs counts only: no address, no file name', async () => {
  reset();
  addDocument({ filename: 'driver-licence-front.png', expires: dayStr(5) });
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await runReminders({ now: NOW });
  } finally {
    console.log = original;
  }
  const out = lines.join('\n');
  assert.match(out, /Reminders: 1 accounts checked, 1 emails/);
  assert.ok(!/alice|example\.com|licence/.test(out));
});

test('reminder rows go with the file (deleted for good, Trash emptied, purged) and with the account', async () => {
  reset();
  const a = addDocument({ expires: dayStr(5), deletedAt: new Date(NOW.getTime() - DAY) });
  const b = addDocument({ expires: dayStr(5), deletedAt: new Date(NOW.getTime() - DAY) });
  const keep = addDocument({ expires: dayStr(5) });
  const seed = (doc) => world.tables.reminderlogs.push({ _id: db.oid(), userId: ALICE, fileId: doc._id, threshold: 7, sent: true });
  [a, b, keep].forEach(seed);
  await deletePermanently(ALICE, 'file', String(a._id));
  assert.equal(world.tables.reminderlogs.filter((r) => String(r.fileId) === String(a._id)).length, 0);
  await emptyTrash(ALICE);
  assert.equal(world.tables.reminderlogs.length, 1);
  assert.equal(String(world.tables.reminderlogs[0].fileId), String(keep._id));
  await deleteAccountData(ALICE, { transaction: false });
  assert.equal(world.tables.reminderlogs.length, 0);
});

// ---------- the cron route ----------
function cronCall(authorization) {
  const layer = cronRouter.stack.find((l) => l.route?.path === '/reminders');
  assert.ok(layer, 'GET /reminders exists');
  assert.equal(layer.route.methods.get, true);
  const [secretCheck, handler] = layer.route.stack.map((s) => s.handle);
  const out = { status: null, json: null, ran: false };
  const res = { status(code) { out.status = code; return this; }, json(payload) { out.json = payload; return this; } };
  const req = { get: (name) => (name.toLowerCase() === 'authorization' ? authorization : undefined) };
  return (async () => {
    let passed = false;
    secretCheck(req, res, () => { passed = true; });
    if (passed) {
      out.ran = true;
      await handler(req, res, (err) => { out.error = err; });
    }
    return out;
  })();
}

test('the cron route refuses without the secret, with a wrong one, and when CRON_SECRET is not set (in production too)', async () => {
  reset();
  addDocument({ expires: dayStr(5, new Date()) });
  const saved = { secret: process.env.CRON_SECRET, env: process.env.NODE_ENV };
  try {
    delete process.env.CRON_SECRET;
    assert.equal((await cronCall('Bearer anything')).status, 404);
    assert.equal((await cronCall(undefined)).status, 404);
    process.env.NODE_ENV = 'production';
    assert.equal((await cronCall('Bearer anything')).status, 404, 'unset in production: nothing runs');
    process.env.NODE_ENV = 'test';

    process.env.CRON_SECRET = 'a-long-random-cron-secret-value';
    for (const bad of [undefined, '', 'Bearer', 'Bearer wrong', 'a-long-random-cron-secret-value', 'bearer a-long-random-cron-secret-value', 'Bearer a-long-random-cron-secret-value ']) {
      const out = await cronCall(bad);
      assert.equal(out.status, 401, String(bad));
      assert.equal(out.ran, false);
    }
    assert.equal(world.mails.length, 0, 'nothing was sent by a refused call');

    const good = await cronCall('Bearer a-long-random-cron-secret-value');
    assert.equal(good.ran, true);
    assert.equal(good.status, 200);
    assert.equal(good.json.emails, 1, 'the authorised call ran the job');
    assert.equal(world.mails.length, 1);
    assert.ok('users' in good.json && 'remaining' in good.json);
  } finally {
    if (saved.secret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved.secret;
    process.env.NODE_ENV = saved.env;
  }
});

test('vercel.json schedules the reminders once a day at 01:00 UTC (09:00 in Manila)', () => {
  const config = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'vercel.json'), 'utf8'));
  const cron = config.crons.find((c) => c.path === '/api/cron/reminders');
  assert.ok(cron);
  assert.equal(cron.schedule, '0 1 * * *');
});

// ---------- the expiring list ----------
test('the expiring list holds only the caller’s live files within 60 days or already expired, soonest first', async () => {
  reset();
  addDocument({ filename: 'a', expires: dayStr(-3) });
  addDocument({ filename: 'b', expires: dayStr(40) });
  addDocument({ filename: 'c', expires: dayStr(90) });
  addDocument({ filename: 'd', expires: dayStr(5), deletedAt: new Date() });
  addDocument({ owner: BOB, filename: 'e', expires: dayStr(1) });
  const out = await call(listExpiringDocuments, { userId: ALICE });
  assert.deepEqual(out.json.map((d) => d.filename), ['a', 'b']);
  assert.deepEqual(out.json.map((d) => d.expiryStatus), ['expired', 'expiring_soon']);
});

// ---------- vault health ----------
const OK = { openShares: 0, oldShares: 0, trustedBrowsers: 0, staleTrusted: 0, suspiciousFlags: 0, expiredDocs: 0, expiringDocs: 0, remindersOn: true, trashNearPurge: 0 };
const itemOf = (result, id) => result.items.find((i) => i.id === id);

test('vault health: the weights add up to 100, nothing wrong scores 100, everything wrong scores 0', () => {
  assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 100);
  const clean = computeVaultHealth(OK);
  assert.equal(clean.score, 100);
  assert.equal(clean.items.length, 9);
  assert.ok(clean.items.every((i) => i.status === 'ok' && i.points === 0 && i.actionPath.startsWith('/')));
  const worst = computeVaultHealth({ openShares: 2, oldShares: 2, trustedBrowsers: 9, staleTrusted: 9, suspiciousFlags: 3, expiredDocs: 1, expiringDocs: 1, remindersOn: false, hasExpiryDates: true, trashNearPurge: 1 });
  // the "warn" items cost half their weight, so only the "bad" ones reach their maximum
  assert.equal(worst.score, 100 - (15 + 5 + 5 + 5 + 25 + 15 + 2 + 2 + 2));
  assert.equal(computeVaultHealth({}).score, 100, 'no facts: nothing is wrong');
  const garbage = computeVaultHealth({ openShares: -4, oldShares: 'x', suspiciousFlags: NaN, trustedBrowsers: null });
  assert.equal(garbage.score, 100);
});

test('vault health: each item and its boundary', () => {
  const rate = (facts) => computeVaultHealth({ ...OK, ...facts });
  // open shares: any is bad
  assert.equal(itemOf(rate({ openShares: 1 }), 'open_shares').status, 'bad');
  assert.equal(itemOf(rate({ openShares: 1 }), 'open_shares').points, 15);
  assert.equal(itemOf(rate({ openShares: 0 }), 'open_shares').status, 'ok');
  // old shares
  assert.equal(itemOf(rate({ oldShares: 1 }), 'old_shares').status, 'warn');
  assert.equal(itemOf(rate({ oldShares: 1 }), 'old_shares').points, 5);
  // trusted browsers: warn ABOVE 3
  assert.equal(itemOf(rate({ trustedBrowsers: 3 }), 'trusted_browsers').status, 'ok');
  assert.equal(itemOf(rate({ trustedBrowsers: 4 }), 'trusted_browsers').status, 'warn');
  assert.equal(itemOf(rate({ staleTrusted: 1 }), 'stale_trusted').status, 'warn');
  assert.equal(itemOf(rate({ staleTrusted: 0 }), 'stale_trusted').status, 'ok');
  // suspicious activity: bad, the biggest weight
  const flagged = rate({ suspiciousFlags: 1 });
  assert.equal(itemOf(flagged, 'suspicious').status, 'bad');
  assert.equal(flagged.score, 75);
  // documents
  assert.equal(itemOf(rate({ expiredDocs: 1 }), 'expired_docs').status, 'bad');
  assert.equal(rate({ expiredDocs: 1 }).score, 85);
  assert.equal(itemOf(rate({ expiringDocs: 2 }), 'expiring_docs').status, 'warn');
  assert.match(itemOf(rate({ expiringDocs: 2 }), 'expiring_docs').detail, /2 documents/);
  // reminders off only matters when some document has a date
  assert.equal(itemOf(rate({ remindersOn: false }), 'reminders_off').status, 'ok');
  assert.equal(itemOf(rate({ remindersOn: false, hasExpiryDates: true }), 'reminders_off').status, 'warn');
  assert.equal(itemOf(rate({ remindersOn: true, hasExpiryDates: true }), 'reminders_off').status, 'ok');
  // trash
  assert.equal(itemOf(rate({ trashNearPurge: 1 }), 'trash_near_purge').status, 'warn');
  // singular and plural wording
  assert.match(itemOf(rate({ openShares: 1 }), 'open_shares').detail, /1 active link /);
  assert.match(itemOf(rate({ openShares: 3 }), 'open_shares').detail, /3 active links /);
  // a mixed vault
  const mixed = rate({ openShares: 1, expiredDocs: 1, trustedBrowsers: 5 });
  assert.equal(mixed.score, 100 - 15 - 15 - 5);
  assert.ok(mixed.items.every((i) => ['ok', 'warn', 'bad'].includes(i.status)));
  // every claim is about something Warden can see: no recovery-key or password-strength items
  assert.ok(!mixed.items.some((i) => /recovery|password strength/i.test(i.label)));
});

test('GET /account/health needs a session and reports only the caller’s own data', async () => {
  const layer = accountRouter.stack.find((l) => l.route?.path === '/health');
  assert.ok(layer, 'route exists');
  assert.equal(layer.route.stack[0].handle, requireSession, 'the session check comes first');
  const prefs = accountRouter.stack.filter((l) => l.route?.path === '/preferences');
  assert.equal(prefs.length, 2);
  assert.ok(prefs.every((l) => l.route.stack[0].handle === requireSession));

  reset();
  const now = Date.now();
  // Alice: one open share, one expired document. Bob: three open shares, a flagged-looking pile of nothing.
  world.tables.shares.push({ _id: db.oid(), ownerUserId: ALICE, ready: true, expiresAt: new Date(now + DAY), createdAt: new Date(now), passwordVerifierHash: null, recipientEmail: null });
  for (let i = 0; i < 3; i += 1) world.tables.shares.push({ _id: db.oid(), ownerUserId: BOB, ready: true, expiresAt: new Date(now + DAY), createdAt: new Date(now - 20 * DAY), passwordVerifierHash: null, recipientEmail: null });
  addDocument({ expires: dayStr(-5, new Date()) });
  addDocument({ owner: BOB, expires: dayStr(-5, new Date()) });
  addDocument({ owner: BOB, expires: dayStr(-9, new Date()) });
  const alice = await call(getHealth, { userId: ALICE });
  assert.equal(alice.status, 200);
  assert.equal(alice.headers['cache-control'], 'no-store');
  assert.equal(itemOf(alice.json, 'open_shares').detail.startsWith('1 active link '), true);
  assert.equal(itemOf(alice.json, 'old_shares').status, 'ok');
  assert.match(itemOf(alice.json, 'expired_docs').detail, /^1 document /);
  const bob = await call(getHealth, { userId: BOB });
  assert.equal(itemOf(bob.json, 'open_shares').detail.startsWith('3 active links '), true);
  assert.equal(itemOf(bob.json, 'old_shares').status, 'warn');
  assert.match(itemOf(bob.json, 'expired_docs').detail, /^2 documents /);
  assert.deepEqual(Object.keys(alice.json).sort(), ['items', 'score']);
  const everything = JSON.stringify(alice.json);
  assert.ok(!everything.includes(String(BOB)) && !everything.includes('bob@example.com'));
});

// ---------- purpose on share links ----------
const PURPOSE = 'For BDO account opening';

async function makeShare(body, doc = addDocument()) {
  const made = await call(createShare, { userId: ALICE, dek: DEK, params: { id: String(doc._id) }, body: { durationHours: 24, ...body } });
  return { made, doc };
}
const keyOf = (shareUrl) => Buffer.from(new URL(shareUrl).hash.slice('#k='.length), 'base64url');
const everyStoredByte = () => {
  const dump = JSON.stringify(world.tables, (key, value) => (value && value.type === 'Buffer' ? Buffer.from(value.data).toString('latin1') : value));
  return dump + JSON.stringify(world.tables, (key, value) => (value && value.type === 'Buffer' ? Buffer.from(value.data).toString('base64') : value));
};

test('purpose: only inside the encrypted manifest and label; nowhere in the database in the clear, no event, mail or log', async () => {
  reset();
  const lines = [];
  const originals = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...args) => lines.push(args.join(' '));
  let made;
  try {
    ({ made } = await makeShare({ purpose: `  ${PURPOSE}  ` }));
    // visitors fetch the manifest through the public endpoint
    const shareId = made.json.id;
    const manifest = await call(viewSharedManifest, { params: { shareId }, headers: {}, query: {}, ip: '198.51.100.5' });
    assert.equal(manifest.status, 200, JSON.stringify(manifest.json || manifest.error?.message));
    assert.ok(!JSON.stringify(manifest.json).includes(PURPOSE));
  } finally {
    Object.assign(console, originals);
  }
  assert.equal(made.status, 201);
  assert.ok(!everyStoredByte().includes(PURPOSE), 'not in any collection, in any encoding');
  assert.ok(!everyStoredByte().includes(Buffer.from(PURPOSE).toString('base64')), 'nor as base64');
  assert.ok(!JSON.stringify(world.tables.auditevents).includes(PURPOSE));
  assert.equal(world.mails.length, 0);
  assert.ok(!lines.join('\n').includes('BDO'), 'not in any log line');
  assert.ok(!JSON.stringify(made.json).includes(PURPOSE), 'the create response does not echo it either');
  assert.equal(world.tables.auditevents.at(-1).type, 'share_created');

  // the viewer (holding the key from the link) can read it, with the day the link was made
  const share = world.tables.shares[0];
  const plain = shareCrypto.unpackAndDecrypt(
    Buffer.concat([share.manifestIv, share.manifestCipher, share.manifestAuthTag].length ? [share.manifestIv, share.manifestCipher, share.manifestAuthTag] : []),
    keyOf(made.json.shareUrl), share.shareId, 'manifest'
  ).toString();
  const parsed = JSON.parse(plain);
  assert.equal(parsed.v, 2);
  assert.equal(parsed.purpose, PURPOSE);
  assert.match(parsed.sharedAt, /^\d{4}-\d{2}-\d{2}$/);

  // the owner's manager shows it (decrypted from their own encrypted label, for their session only)
  const list = await call(listAllShares, { userId: ALICE, dek: DEK });
  assert.equal(list.json.shares[0].purpose, PURPOSE);
});

test('no purpose: the manifest and the owner list are exactly as before', async () => {
  reset();
  const { made } = await makeShare({});
  const share = world.tables.shares[0];
  const parsed = JSON.parse(
    shareCrypto.unpackAndDecrypt(Buffer.concat([share.manifestIv, share.manifestCipher, share.manifestAuthTag]), keyOf(made.json.shareUrl), share.shareId, 'manifest').toString()
  );
  assert.equal(parsed.v, 1);
  assert.deepEqual(Object.keys(parsed).sort(), ['files', 'v']);
  const list = await call(listAllShares, { userId: ALICE, dek: DEK });
  assert.equal(list.json.shares[0].purpose, null);
  for (const empty of ['', '   ', null, '​\n']) {
    const r = await makeShare({ purpose: empty });
    assert.equal(r.made.status, 201, JSON.stringify(empty));
  }
});

test('purpose: at most 60 characters, plain text, cleaned', async () => {
  reset();
  assert.equal((await makeShare({ purpose: 'x'.repeat(61) })).made.error?.status, 400);
  assert.equal((await makeShare({ purpose: 12345 })).made.error?.status, 400);
  assert.equal((await makeShare({ purpose: { a: 1 } })).made.error?.status, 400);
  assert.equal((await makeShare({ purpose: 'é'.repeat(60) })).made.status, 201);
  assert.equal((await makeShare({ purpose: '🙂'.repeat(60) })).made.status, 201, 'counted in characters, not bytes');
  await makeShare({ purpose: 'a‮b\r\nc\td' });
  const list = await call(listAllShares, { userId: ALICE, dek: DEK });
  const cleaned = list.json.shares.map((s) => s.purpose).find((p) => p && p.startsWith('a'));
  assert.equal(cleaned, 'a b c d', 'control and direction-override characters become spaces');
});

test('the older expiryDate name is the same single date: PATCH writes docExpiresAt, the list thresholds are 60 days', async () => {
  reset();
  const doc = addDocument();
  const req = (body) => ({ userId: ALICE, dek: DEK, params: { id: String(doc._id) }, body });
  const viaOldName = await call(updateDocument, req({ expiryDate: '2027-03-05T16:00:00.000Z' }));
  assert.equal(viaOldName.status, 200);
  assert.equal(doc.docExpiresAt.toISOString(), '2027-03-05T00:00:00.000Z', 'cut to its day');
  assert.equal(doc.expiryDate, undefined);
  assert.deepEqual(world.tables.auditevents.map((e) => e.type), ['expiry_set']);

  const soon = addDocument({ filename: 'soon.png', expires: dayStr(55, new Date()) });
  const far = addDocument({ filename: 'far.png', expires: dayStr(65, new Date()) });
  const out = await call(listExpiringDocuments, { userId: ALICE });
  assert.ok(out.json.some((d) => d.id === soon._id));
  assert.ok(!out.json.some((d) => d.id === far._id));
});

test('the document list asks the database for docExpiresAt (a fake database ignores the projection, a real one does not)', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'controllers', 'documents.controller.js'), 'utf8');
  assert.match(source, /const LIST_PROJECTION = {[^}]*docExpiresAt: 1/);
});
