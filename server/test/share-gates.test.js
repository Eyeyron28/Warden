// Run with: cd server && npm test   (Node's built-in test runner, no deps)
//
// The gates and rules on a share: link password, download limit, emailed-code
// recipient restriction, and the owner's share manager. As with shares.test.js
// the models are in-memory fakes installed before the controllers load.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.PUBLIC_APP_URL = 'https://warden.test';
delete process.env.VERCEL;
delete process.env.OTP_TTL_MINUTES;
process.env.NODE_ENV = 'test';

const { encryptFile } = require('../utils/crypto');
const shareCrypto = require('../utils/shareCrypto');
const limits = require('../utils/shareLimits');
const db = require('./helpers/fakeDb');

const world = db.createWorld();
const sameId = (a, b) => String(a) === String(b);

db.installModels(world, {
  Document: {
    aggregate: async (pipeline) => {
      const ids = pipeline[0].$match._id.$in.map(String);
      return world.tables.documents
        .filter((d) => ids.includes(String(d._id)) && sameId(d.userId, pipeline[0].$match.userId))
        .map((d) => ({ _id: d._id, size: d.encryptedBlob.length }));
    },
  },
  Share: {
    aggregate: async (pipeline) => {
      const live = world.tables.shares.filter((s) => sameId(s.ownerUserId, pipeline[0].$match.ownerUserId) && s.expiresAt.getTime() > Date.now());
      return live.length ? [{ _id: null, bytes: live.reduce((n, s) => n + s.totalBytes, 0), shares: live.length }] : [];
    },
  },
});
const counts = db.installRateLimit();
db.installMailer(world);

const S = require('../controllers/shares.controller');
const V = require('../controllers/sharedView.controller');
const { consumeChallenge } = require('../utils/otpChallenge');
const { call } = db;

// ---------- helpers ----------
const DEK = crypto.randomBytes(32);
const ALICE = db.oid();
const BOB = db.oid();
const ALICE_EMAIL = 'alice@example.com';

function reset() {
  for (const name of Object.keys(world.tables)) world.tables[name] = [];
  world.mails = [];
  counts.clear();
  world.tables.users.push({ _id: ALICE, email: ALICE_EMAIL });
}

function addDocument(filename = 'passport.png', content = crypto.randomBytes(512)) {
  const sealed = encryptFile(content, DEK);
  const doc = {
    _id: db.oid(), userId: ALICE, filename, mimeType: 'image/png', folder: 'root',
    encryptedBlob: Buffer.from(sealed.ciphertext, 'base64'), iv: sealed.iv, authTag: sealed.authTag,
    checksum: crypto.createHash('sha256').update(content).digest('hex'), plaintext: content,
  };
  world.tables.documents.push(doc);
  return doc;
}

const as = (userId, extra = {}) => ({ userId, dek: DEK, ...extra });
const keyOf = (url) => Buffer.from(new URL(url).hash.slice(3), 'base64url');

async function makeShare(body = {}, docs = [addDocument()]) {
  const result = await call(S.createBulkShare, { ...as(ALICE), body: { documentIds: docs.map((d) => String(d._id)), durationHours: 24, ...body } });
  assert.equal(result.error, null, result.error?.message);
  return { ...result.json, shareKey: keyOf(result.json.shareUrl), docs };
}

// What the browser does with a password: scrypt -> two HMAC labels -> a wrap key and a verifier.
const WRAP_LABEL = 'warden-share-wrap-v1';
const VERIFY_LABEL = 'warden-share-verify-v1';
const KDF = { N: 2 ** 15, r: 8, p: 1 };
function derive(password, salt) {
  const master = crypto.scryptSync(password.normalize('NFKC'), salt, 32, { ...KDF, maxmem: 128 * 1024 * 1024 });
  const mac = (label) => crypto.createHmac('sha256', master).update(label).digest();
  return { wrapKey: mac(WRAP_LABEL), verifier: mac(VERIFY_LABEL) };
}
function passwordBody(password, shareKey, shareId) {
  const salt = crypto.randomBytes(16);
  const { wrapKey, verifier } = derive(password, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', wrapKey, iv);
  cipher.setAAD(Buffer.from(`${shareId}:key`));
  const ct = Buffer.concat([cipher.update(shareKey), cipher.final()]);
  return {
    salt: salt.toString('base64'),
    kdf: KDF,
    wrappedKey: Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64'),
    verifier: verifier.toString('base64'),
  };
}
function unwrap(wrappedB64, wrapKey, shareId) {
  const blob = Buffer.from(wrappedB64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', wrapKey, blob.subarray(0, 12));
  d.setAAD(Buffer.from(`${shareId}:key`));
  d.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]);
}

const open = async (shareId) => (await call(V.openAccess, { params: { shareId } })).json;
const hdr = (token) => ({ 'x-share-access': token });
const manifestOf = (shareId, token) => call(V.viewSharedManifest, { params: { shareId }, headers: hdr(token) });
const fileOf = (shareId, fileId, token) => call(V.viewSharedFile, { params: { shareId, fileId }, headers: hdr(token) });
const lastCode = () => /^(\d{6})$/m.exec(world.mails[world.mails.length - 1].text)[1];
const wrongOf = (c) => (c === '000000' ? '000001' : '000000');
const GENERIC_404 = 'This link is invalid or has expired.';

// ---------- 1. link password ----------
test('a password share is hidden until its key is wrapped, then goes live; the server stores neither password nor key', async () => {
  reset();
  const made = await makeShare({ passwordProtected: true });
  assert.equal(made.passwordPending, true);
  const [share] = world.tables.shares;
  assert.equal(share.ready, false);
  assert.ok(share.expiresAt.getTime() - Date.now() <= limits.PENDING_MINUTES * 60 * 1000 + 1000, 'short-lived while pending');
  assert.ok(world.tables.sharedfiles.every((f) => f.expiresAt.getTime() === share.expiresAt.getTime()));
  const hidden = await call(V.openAccess, { params: { shareId: made.id } });
  assert.equal(hidden.error.message, GENERIC_404, 'invisible to the public until finalised');

  const body = passwordBody('Correct Horse Battery', made.shareKey, made.id);
  const done = await call(S.setPassword, { ...as(ALICE), params: { shareId: made.id }, body });
  assert.equal(done.status, 200);
  assert.equal(share.ready, true);
  assert.ok(Math.abs(share.expiresAt.getTime() - (Date.now() + 24 * 3600 * 1000)) < 5000, 'real expiry restored');
  assert.ok(world.tables.sharedfiles.every((f) => f.expiresAt.getTime() === share.expiresAt.getTime()));

  const stored = JSON.stringify(world.tables.shares[0]) + JSON.stringify(world.tables.sharedfiles);
  assert.ok(!stored.includes('Correct Horse Battery'), 'no password');
  assert.ok(!stored.includes(made.shareKey.toString('hex')) && !stored.includes(made.shareKey.toString('base64')) && !stored.includes(made.shareKey.toString('base64url')), 'no plain share key');
  assert.ok(!stored.includes(DEK.toString('hex')) && !stored.includes(DEK.toString('base64')), 'no vault key');
  assert.deepEqual(
    Object.keys(share).filter((k) => k.startsWith('password')).sort(),
    ['passwordKdfN', 'passwordKdfP', 'passwordKdfR', 'passwordSalt', 'passwordVerifierHash', 'passwordWrappedKey']
  );

  // The wrapped key opens only with the password; the stored verifier hash opens nothing.
  const { wrapKey, verifier } = derive('Correct Horse Battery', Buffer.from(share.passwordSalt, 'base64'));
  assert.ok(unwrap(share.passwordWrappedKey, wrapKey, made.id).equals(made.shareKey));
  assert.throws(() => unwrap(share.passwordWrappedKey, derive('wrong password', Buffer.from(share.passwordSalt, 'base64')).wrapKey, made.id));
  assert.throws(() => unwrap(share.passwordWrappedKey, Buffer.from(share.passwordVerifierHash, 'hex'), made.id), 'the stored hash is not a key');
  assert.throws(() => unwrap(share.passwordWrappedKey, verifier, made.id), 'the verifier is not the wrap key (domain separation)');
  assert.notEqual(share.passwordVerifierHash, verifier.toString('hex'), 'only a hash of the verifier is kept');
});

test('weak or malformed password material is refused', async () => {
  reset();
  const made = await makeShare({ passwordProtected: true });
  const good = passwordBody('pw', made.shareKey, made.id);
  const bad = [
    { ...good, kdf: { N: 1024, r: 8, p: 1 } },
    { ...good, kdf: { N: 2 ** 15 + 1, r: 8, p: 1 } },
    { ...good, kdf: { N: 2 ** 20, r: 8, p: 1 } },
    { ...good, kdf: { N: 2 ** 15, r: 1, p: 1 } },
    { ...good, wrappedKey: 'AAAA' },
    { ...good, verifier: Buffer.alloc(16).toString('base64') },
    { ...good, salt: 'AA==' },
    { ...good, verifier: '<script>' },
    {},
  ];
  for (const body of bad) {
    const r = await call(S.setPassword, { ...as(ALICE), params: { shareId: made.id }, body });
    assert.equal(r.error?.status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal(world.tables.shares[0].ready, false, 'still pending');
});

test('password gate: nothing is served before it, a wrong password is generic, 5 wrong attempts lock the share', async () => {
  reset();
  const made = await makeShare({ passwordProtected: true });
  await call(S.setPassword, { ...as(ALICE), params: { shareId: made.id }, body: passwordBody('open sesame', made.shareKey, made.id) });
  const access = await open(made.id);
  assert.equal(access.needsPassword, true);
  assert.equal(access.needsEmail, false);
  assert.deepEqual(access.password.kdf, KDF, 'the salt and cost come with the access so the browser can derive the verifier');
  assert.equal(access.password.salt, world.tables.shares[0].passwordSalt);
  assert.ok(!JSON.stringify(access).includes(world.tables.shares[0].passwordWrappedKey), 'the wrapped key is not released at this step');

  const fileId = world.tables.sharedfiles[0].fileId;
  assert.equal((await manifestOf(made.id)).error.message, GENERIC_404, 'no token');
  assert.equal((await manifestOf(made.id, access.accessToken)).error.message, GENERIC_404, 'token but no password yet');
  assert.equal((await fileOf(made.id, fileId, access.accessToken)).error.message, GENERIC_404);
  assert.equal(world.tables.shares[0].downloadCount ?? 0, 0, 'a refused request is not a download');

  const salt = Buffer.from(world.tables.shares[0].passwordSalt, 'base64');
  const wrong = derive('not the password', salt).verifier.toString('base64');
  const right = derive('open sesame', salt).verifier.toString('base64');
  for (let i = 0; i < 5; i += 1) {
    const r = await call(V.unlockPassword, { params: { shareId: made.id }, headers: hdr(access.accessToken), body: { verifier: wrong } });
    assert.equal(r.error.status, 401);
    assert.equal(r.error.message, 'That password is incorrect.');
  }
  const locked = await call(V.unlockPassword, { params: { shareId: made.id }, headers: hdr(access.accessToken), body: { verifier: right } });
  assert.equal(locked.error.status, 429, 'after 5 wrong attempts even the right password waits');
  assert.equal(locked.json, null);
  const other = await open(made.id);
  const stillLocked = await call(V.unlockPassword, { params: { shareId: made.id }, headers: hdr(other.accessToken), body: { verifier: right } });
  assert.equal(stillLocked.error.status, 429, 'a new visit does not reset the lock');
});

test('the right password releases the wrapped key and the ciphertext, and only for that visit and share', async () => {
  reset();
  const doc = addDocument('lease.pdf', Buffer.from('rent is due'));
  const made = await makeShare({ passwordProtected: true }, [doc]);
  await call(S.setPassword, { ...as(ALICE), params: { shareId: made.id }, body: passwordBody('open sesame', made.shareKey, made.id) });
  const other = await makeShare({}, [addDocument()]);

  const access = await open(made.id);
  const salt = Buffer.from(world.tables.shares.find((s) => s.shareId === made.id).passwordSalt, 'base64');
  const { wrapKey, verifier } = derive('open sesame', salt);
  const unlocked = await call(V.unlockPassword, { params: { shareId: made.id }, headers: hdr(access.accessToken), body: { verifier: verifier.toString('base64') } });
  assert.equal(unlocked.status, 200);
  assert.deepEqual(Object.keys(unlocked.json).sort(), ['kdf', 'salt', 'wrappedKey']);
  const shareKey = unwrap(unlocked.json.wrappedKey, wrapKey, made.id);
  assert.ok(shareKey.equals(made.shareKey));

  const manifest = await manifestOf(made.id, access.accessToken);
  assert.equal(manifest.status, 200);
  const file = world.tables.sharedfiles.find((f) => f.shareId === made.id);
  const served = await fileOf(made.id, file.fileId, access.accessToken);
  assert.equal(served.status, 200);
  assert.ok(shareCrypto.unpackAndDecrypt(served.body, shareKey, made.id, file.fileId).equals(Buffer.from('rent is due')));

  // The token is bound to its share: on another share it is nothing.
  const otherFile = world.tables.sharedfiles.find((f) => f.shareId === other.id);
  const replay = await fileOf(other.id, otherFile.fileId, access.accessToken);
  assert.equal(replay.status, 200, 'an ungated share needs no token at all');
  const wrongToken = await manifestOf(made.id, crypto.randomBytes(32).toString('hex'));
  assert.equal(wrongToken.error.message, GENERIC_404);
  const junk = await manifestOf(made.id, 'not-a-token');
  assert.equal(junk.error.message, GENERIC_404);
});

// ---------- 2. download count and limit ----------
test('every delivered file counts once, and the limit deletes the share and its copies', async () => {
  reset();
  const made = await makeShare({ maxDownloads: 2 }, [addDocument('a.png'), addDocument('b.png'), addDocument('c.png')]);
  const access = await open(made.id);
  assert.equal(access.limited, true);
  const [f1, f2, f3] = world.tables.sharedfiles.map((f) => f.fileId);

  assert.equal((await fileOf(made.id, f1, access.accessToken)).status, 200);
  assert.equal(world.tables.shares[0].downloadCount, 1);
  assert.equal((await fileOf(made.id, f1, access.accessToken)).status, 200, 'the same file again is another download');
  assert.equal(world.tables.shares.length, 0, 'the last allowed download removed the share');
  assert.equal(world.tables.sharedfiles.length, 0, '...and every encrypted copy');
  assert.equal(world.tables.shareaccess.length, 0);
  const after = await fileOf(made.id, f2, access.accessToken);
  assert.equal(after.error.message, GENERIC_404, 'the generic 404 afterwards');
  assert.equal((await manifestOf(made.id, access.accessToken)).error.message, GENERIC_404);
  assert.equal((await call(V.openAccess, { params: { shareId: made.id } })).error.message, GENERIC_404);
  assert.ok(f3);
});

test('simultaneous requests can never take more downloads than the limit', async () => {
  reset();
  const made = await makeShare({ maxDownloads: 3 }, [addDocument()]);
  const fileId = world.tables.sharedfiles[0].fileId;
  const results = await Promise.all(Array.from({ length: 8 }, () => fileOf(made.id, fileId)));
  assert.equal(results.filter((r) => r.status === 200).length, 3);
  assert.equal(results.filter((r) => r.error).length, 5);
});

test('the owner sees the count; limits are validated; a limit below the count is refused', async () => {
  reset();
  const made = await makeShare({}, [addDocument()]);
  const fileId = world.tables.sharedfiles[0].fileId;
  await fileOf(made.id, fileId);
  await fileOf(made.id, fileId);
  const listed = await call(S.listAllShares, as(ALICE));
  assert.equal(listed.json.shares[0].downloadCount, 2);
  assert.equal(listed.json.shares[0].maxDownloads, null);

  for (const bad of [0, 101, 1.5, -1, 'abc', {}]) {
    const r = await call(S.createBulkShare, { ...as(ALICE), body: { documentIds: [String(world.tables.documents[0]._id)], durationHours: 1, maxDownloads: bad } });
    assert.equal(r.error?.status, 400, String(JSON.stringify(bad)));
  }
  const tooLow = await call(S.updateShare, { ...as(ALICE), params: { shareId: made.id }, body: { maxDownloads: 2 } });
  assert.equal(tooLow.error.status, 409);
  const ok = await call(S.updateShare, { ...as(ALICE), params: { shareId: made.id }, body: { maxDownloads: 3 } });
  assert.equal(ok.json.maxDownloads, 3);
  const cleared = await call(S.updateShare, { ...as(ALICE), params: { shareId: made.id }, body: { maxDownloads: null } });
  assert.equal(cleared.json.maxDownloads, null);
});

// ---------- 3. email-restricted ----------
test('recipient address must be one plain address', async () => {
  reset();
  const doc = addDocument();
  for (const bad of ['a,b@evil.com', 'Victim <v@example.com>', 'vic tim@example.com', 'v@example.com\r\nBcc: x@evil.com', 'user@bücher.example', 'nope']) {
    const r = await call(S.createBulkShare, { ...as(ALICE), body: { documentIds: [String(doc._id)], durationHours: 1, recipientEmail: bad } });
    assert.equal(r.error?.status, 400, bad);
  }
  assert.equal(world.tables.shares.length, 0);
  const ok = await makeShare({ recipientEmail: '  Bob@Example.COM ' }, [doc]);
  assert.equal(ok.recipientEmail, 'bob@example.com');
});

test('email gate: nothing is served before the code; the right code works once; the email holds no link or key', async () => {
  reset();
  const made = await makeShare({ recipientEmail: 'bob@example.com' });
  const fileId = world.tables.sharedfiles[0].fileId;
  const access = await open(made.id);
  assert.equal(access.needsEmail, true);
  assert.equal(access.maskedEmail, 'b**@example.com');
  assert.ok(!JSON.stringify(access).includes('bob@example.com'), 'the full address is not disclosed');

  assert.equal((await manifestOf(made.id, access.accessToken)).error.message, GENERIC_404);
  assert.equal((await fileOf(made.id, fileId, access.accessToken)).error.message, GENERIC_404);
  assert.equal(world.tables.shares[0].downloadCount ?? 0, 0);

  const sent = await call(V.requestEmailCode, { params: { shareId: made.id }, headers: hdr(access.accessToken) });
  assert.equal(sent.status, 200);
  assert.equal(world.mails.length, 1);
  const mail = world.mails[0];
  assert.equal(mail.to, 'bob@example.com');
  assert.match(mail.text, /Someone shared a document with you on Warden/);
  assert.doesNotMatch(mail.text, /alice@example\.com/, 'the owner\'s address is not in the recipient\'s email');
  assert.match(mail.text, /expires in 5 minutes/);
  const key = made.shareKey;
  for (const forbidden of [made.id, key.toString('hex'), key.toString('base64'), key.toString('base64url'), 'https://', 'http://', '#k=', 'warden.test', '/shared/']) {
    assert.ok(!mail.text.includes(forbidden) && !mail.subject.includes(forbidden), `email must not contain ${forbidden}`);
  }

  const code = lastCode();
  const wrong = await call(V.verifyEmailCode, { params: { shareId: made.id }, headers: hdr(access.accessToken), body: { code: wrongOf(code) } });
  assert.equal(wrong.error.status, 401);
  assert.equal(wrong.error.message, 'That code is incorrect or has expired.');
  assert.equal((await manifestOf(made.id, access.accessToken)).error.message, GENERIC_404, 'still closed after a wrong code');

  const right = await call(V.verifyEmailCode, { params: { shareId: made.id }, headers: hdr(access.accessToken), body: { code } });
  assert.equal(right.status, 200);
  assert.equal((await manifestOf(made.id, access.accessToken)).status, 200);
  assert.equal((await fileOf(made.id, fileId, access.accessToken)).status, 200);
  const again = await call(V.verifyEmailCode, { params: { shareId: made.id }, headers: hdr(access.accessToken), body: { code } });
  assert.equal(again.error.status, 401, 'the code works once');
  assert.equal(world.tables.otpchallenges.length, 0, 'and is gone');
});

test('email gate: 5 guesses then the code is dead; the stored code is only a hash', async () => {
  reset();
  const made = await makeShare({ recipientEmail: 'bob@example.com' });
  const access = await open(made.id);
  await call(V.requestEmailCode, { params: { shareId: made.id }, headers: hdr(access.accessToken) });
  const code = lastCode();
  const stored = JSON.stringify(world.tables.otpchallenges);
  assert.ok(!stored.includes(code), 'no plaintext code');
  assert.deepEqual(
    Object.keys(world.tables.otpchallenges[0]).sort(),
    ['_id', 'accessId', 'attempts', 'codeHash', 'expiresAt', 'lastSentAt', 'purpose', 'resendCount', 'salt', 'shareId', 'userId'].sort()
  );
  assert.equal(world.tables.otpchallenges[0].purpose, 'share-email');
  const ttl = world.tables.otpchallenges[0].expiresAt.getTime() - Date.now();
  assert.ok(ttl > 4.9 * 60 * 1000 && ttl <= 5 * 60 * 1000, '5-minute TTL');
  for (let i = 0; i < 5; i += 1) {
    const r = await call(V.verifyEmailCode, { params: { shareId: made.id }, headers: hdr(access.accessToken), body: { code: wrongOf(code) } });
    assert.equal(r.error.status, 401);
  }
  const late = await call(V.verifyEmailCode, { params: { shareId: made.id }, headers: hdr(access.accessToken), body: { code } });
  assert.equal(late.error.status, 401, 'the correct code no longer works');
  assert.equal(world.tables.otpchallenges.length, 0);
});

test('email gate: resend rules (60 s, 3 per challenge, 5 emails per hour per share); the old code stops working', async () => {
  reset();
  const made = await makeShare({ recipientEmail: 'bob@example.com' });
  const access = await open(made.id);
  const h = { params: { shareId: made.id }, headers: hdr(access.accessToken) };
  await call(V.requestEmailCode, h);
  const first = lastCode();

  const soon = await call(V.requestEmailCode, h);
  assert.equal(soon.error.status, 429);
  assert.ok(soon.error.retryAfterSeconds > 0 && soon.error.retryAfterSeconds <= 60);
  assert.equal(world.mails.length, 1);

  const age = () => { world.tables.otpchallenges[0].lastSentAt = new Date(Date.now() - 61000); };
  let previous = first;
  for (let i = 1; i <= 3; i += 1) {
    age();
    const r = await call(V.requestEmailCode, h);
    assert.equal(r.status, 200, `resend ${i}`);
    assert.equal(r.json.resendsLeft, 3 - i);
    const fresh = lastCode();
    if (fresh !== previous) {
      const old = await call(V.verifyEmailCode, { ...h, body: { code: previous } });
      assert.equal(old.error.status, 401, 'the previous code stops working');
      world.tables.otpchallenges[0].attempts = 0;
    }
    previous = fresh;
  }
  age();
  const fourth = await call(V.requestEmailCode, h);
  assert.equal(fourth.error.status, 429, 'a 4th resend is refused');
  assert.equal(world.mails.length, 4);

  // 5 code emails per hour per SHARE, across visitors: 4 sent so far, one more is allowed, then no more.
  const visitor2 = await open(made.id);
  const r5 = await call(V.requestEmailCode, { params: { shareId: made.id }, headers: hdr(visitor2.accessToken) });
  assert.equal(r5.status, 200);
  const visitor3 = await open(made.id);
  const r6 = await call(V.requestEmailCode, { params: { shareId: made.id }, headers: hdr(visitor3.accessToken) });
  assert.equal(r6.error.status, 429);
  assert.equal(world.mails.length, 5, 'never more than 5 per hour');
});

test('a login or delete-account code cannot be used here, and a share code cannot log in or delete', async () => {
  reset();
  const made = await makeShare({ recipientEmail: 'bob@example.com' });
  const access = await open(made.id);
  const { generateCode, newSalt, hashCode } = require('../utils/otp');
  // A pending LOGIN challenge and a pending DELETE challenge, with codes we know.
  for (const purpose of ['login', 'delete-account']) {
    const salt = newSalt();
    world.tables.otpchallenges.push({
      _id: db.oid(), userId: ALICE, purpose, attempts: 0, resendCount: 0, salt, codeHash: hashCode(salt, '123456'),
      lastSentAt: new Date(), expiresAt: new Date(Date.now() + 300000), wrappedDek: 'x', wrappedDekIv: 'x', wrappedDekAuthTag: 'x',
    });
  }
  const attempt = await call(V.verifyEmailCode, { params: { shareId: made.id }, headers: hdr(access.accessToken), body: { code: '123456' } });
  assert.equal(attempt.error.status, 401, 'no share challenge exists, so neither code opens the share');
  assert.equal((await manifestOf(made.id, access.accessToken)).error.message, GENERIC_404);
  assert.equal(world.tables.otpchallenges.length, 2, 'and the other challenges were not touched');
  assert.ok(world.tables.otpchallenges.every((c) => c.attempts === 0));

  // The other direction: a share-email challenge is invisible to login and delete lookups.
  await call(V.requestEmailCode, { params: { shareId: made.id }, headers: hdr(access.accessToken) });
  const shareChallenge = world.tables.otpchallenges.find((c) => c.purpose === 'share-email');
  const token = `${shareChallenge._id}.${crypto.randomBytes(32).toString('hex')}`;
  for (const purpose of ['login', 'delete-account']) {
    await assert.rejects(consumeChallenge({ challengeToken: token, code: lastCode(), purpose }), /incorrect or has expired/);
  }
  assert.equal(shareChallenge.attempts, 0, 'those attempts never reached the share challenge');
  assert.ok(generateCode);
});

test('both gates: the code comes first, then the password', async () => {
  reset();
  const made = await makeShare({ passwordProtected: true, recipientEmail: 'bob@example.com' });
  await call(S.setPassword, { ...as(ALICE), params: { shareId: made.id }, body: passwordBody('open sesame', made.shareKey, made.id) });
  const access = await open(made.id);
  assert.equal(access.needsEmail && access.needsPassword, true);
  const salt = Buffer.from(world.tables.shares[0].passwordSalt, 'base64');
  const verifier = derive('open sesame', salt).verifier.toString('base64');

  const early = await call(V.unlockPassword, { params: { shareId: made.id }, headers: hdr(access.accessToken), body: { verifier } });
  assert.equal(early.error.message, GENERIC_404, 'the password step does not run before the emailed code');
  await call(V.requestEmailCode, { params: { shareId: made.id }, headers: hdr(access.accessToken) });
  await call(V.verifyEmailCode, { params: { shareId: made.id }, headers: hdr(access.accessToken), body: { code: lastCode() } });
  assert.equal((await manifestOf(made.id, access.accessToken)).error.message, GENERIC_404, 'code passed, password still needed');
  const unlocked = await call(V.unlockPassword, { params: { shareId: made.id }, headers: hdr(access.accessToken), body: { verifier } });
  assert.equal(unlocked.status, 200);
  assert.equal((await manifestOf(made.id, access.accessToken)).status, 200);
});

// ---------- 4. the share manager ----------
test('manager: change expiry within the cap, add and remove a password, change the recipient', async () => {
  reset();
  const made = await makeShare({}, [addDocument('a.png'), addDocument('b.png')]);
  const sid = made.id;
  const patch = (body, userId = ALICE) => call(S.updateShare, { ...as(userId), params: { shareId: sid }, body });

  const sooner = await patch({ durationHours: 2 });
  assert.equal(sooner.status, 200);
  assert.ok(Math.abs(new Date(sooner.json.expiresAt).getTime() - (Date.now() + 2 * 3600 * 1000)) < 5000);
  assert.ok(world.tables.sharedfiles.every((f) => Math.abs(f.expiresAt.getTime() - (Date.now() + 2 * 3600 * 1000)) < 5000), 'the copies expire with it');
  const later = await patch({ durationHours: 24 * 29 });
  assert.equal(later.status, 200, 'within 30 days of creation');
  const tooFar = await patch({ durationHours: 24 * 31 });
  assert.equal(tooFar.error.status, 400);
  assert.match(tooFar.error.message, /30 days/);
  assert.equal((await patch({ durationHours: -5 })).error.status, 400);
  assert.equal((await patch({})).error.status, 400);
  assert.equal((await patch({ recipientEmail: 'a,b@evil.com' })).error.status, 400);
  assert.equal((await patch({ recipientEmail: 'carol@example.com' })).json.emailRestricted, true);
  assert.equal((await patch({ recipientEmail: null })).json.emailRestricted, false);

  // Add a password later (the owner's browser supplies wrapped material; no re-upload).
  const filesBefore = JSON.stringify(world.tables.sharedfiles);
  const added = await call(S.setPassword, { ...as(ALICE), params: { shareId: sid }, body: passwordBody('first pw', made.shareKey, sid) });
  assert.equal(added.status, 200);
  assert.equal(JSON.stringify(world.tables.sharedfiles.map(({ ciphertext, iv, authTag }) => ({ ciphertext, iv, authTag }))), JSON.stringify(JSON.parse(filesBefore).map(({ ciphertext, iv, authTag }) => ({ ciphertext, iv, authTag }))), 'ciphertext untouched');
  const prot = await call(S.getProtection, { ...as(ALICE), params: { shareId: sid } });
  assert.equal(prot.json.passwordProtected, true);
  assert.deepEqual(Object.keys(prot.json).sort(), ['kdf', 'passwordProtected', 'salt', 'wrappedKey']);

  // Change it: the owner's browser unwraps with the old password and re-wraps.
  const oldKey = unwrap(prot.json.wrappedKey, derive('first pw', Buffer.from(prot.json.salt, 'base64')).wrapKey, sid);
  assert.ok(oldKey.equals(made.shareKey));
  const changed = await call(S.setPassword, { ...as(ALICE), params: { shareId: sid }, body: passwordBody('second pw', oldKey, sid) });
  assert.equal(changed.status, 200);
  const access = await open(sid);
  const salt2 = Buffer.from(world.tables.shares[0].passwordSalt, 'base64');
  const oldVerifier = derive('first pw', salt2).verifier.toString('base64');
  const rejected = await call(V.unlockPassword, { params: { shareId: sid }, headers: hdr(access.accessToken), body: { verifier: oldVerifier } });
  assert.equal(rejected.error.status, 401, 'the old password no longer works');
  const accepted = await call(V.unlockPassword, { params: { shareId: sid }, headers: hdr(access.accessToken), body: { verifier: derive('second pw', salt2).verifier.toString('base64') } });
  assert.equal(accepted.status, 200);

  // Remove it: back to a plain key-in-the-link share.
  const removed = await call(S.removePassword, { ...as(ALICE), params: { shareId: sid } });
  assert.equal(removed.json.passwordProtected, false);
  assert.ok(Object.keys(world.tables.shares[0]).filter((k) => k.startsWith('password')).every((k) => world.tables.shares[0][k] === null), 'every password field cleared');
  assert.equal((await call(S.removePassword, { ...as(ALICE), params: { shareId: sid } })).error.status, 409);
  const fileId = world.tables.sharedfiles[0].fileId;
  assert.equal((await fileOf(sid, fileId)).status, 200, 'ungated again');
});

test('manager: another account gets 404 on every operation; stop sharing and stop-all delete the copies', async () => {
  reset();
  const made = await makeShare({}, [addDocument()]);
  const bobs = await (async () => {
    world.tables.documents.push({ ...world.tables.documents[0], _id: db.oid(), userId: BOB });
    const r = await call(S.createBulkShare, { ...as(BOB), body: { documentIds: [String(world.tables.documents[1]._id)], durationHours: 24 } });
    return r.json;
  })();
  const p = { params: { shareId: made.id } };
  for (const [name, handler, body] of [
    ['patch', S.updateShare, { maxDownloads: 5 }],
    ['password put', S.setPassword, passwordBody('x', made.shareKey, made.id)],
    ['password delete', S.removePassword, {}],
    ['protection', S.getProtection, {}],
    ['manifest', S.getOwnerManifest, {}],
    ['revoke', S.revokeShare, {}],
  ]) {
    const r = await call(handler, { ...as(BOB), ...p, body });
    assert.equal(r.error?.status, 404, name);
  }
  assert.equal(world.tables.shares.length, 2);
  assert.equal(world.tables.shares.find((s) => s.shareId === made.id).maxDownloads, null, 'untouched');

  // Stop all (alice) leaves bob's share alone.
  const second = await makeShare({ recipientEmail: 'bob@example.com' }, [addDocument()]);
  const access = await open(second.id);
  await call(V.requestEmailCode, { params: { shareId: second.id }, headers: hdr(access.accessToken) });
  const stopped = await call(S.stopAllShares, as(ALICE));
  assert.equal(stopped.json.stopped, 2);
  assert.deepEqual(world.tables.shares.map((s) => s.shareId), [bobs.id]);
  assert.ok(world.tables.sharedfiles.every((f) => f.shareId === bobs.id), 'only bob\'s copies remain');
  assert.equal(world.tables.shareaccess.length, 0, 'visitor sessions are gone');
  assert.equal(world.tables.otpchallenges.length, 0, 'and the pending code challenge');
  assert.equal((await call(V.openAccess, { params: { shareId: made.id } })).error.message, GENERIC_404);

  const single = await call(S.revokeShare, { ...as(BOB), params: { shareId: bobs.id } });
  assert.equal(single.status, 200);
  assert.equal(world.tables.sharedfiles.length, 0);
});

test('the owner manifest lets the browser check a pasted key; it is ciphertext only', async () => {
  reset();
  const made = await makeShare({}, [addDocument('secret.pdf')]);
  const r = await call(S.getOwnerManifest, { ...as(ALICE), params: { shareId: made.id } });
  const blob = Buffer.from(r.json.manifest, 'base64');
  const plain = JSON.parse(shareCrypto.unpackAndDecrypt(blob, made.shareKey, made.id, 'manifest').toString());
  assert.equal(plain.files[0].name, 'secret.pdf');
  assert.throws(() => shareCrypto.unpackAndDecrypt(blob, crypto.randomBytes(32), made.id, 'manifest'));
  assert.ok(!JSON.stringify(r.json).includes('secret'));
});
