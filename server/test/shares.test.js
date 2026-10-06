// Run with: cd server && npm test   (Node's built-in test runner, no deps)
//
// Share links: the per-share key never reaches the server, the database
// holds only ciphertext, limits are enforced, and no endpoint serves shared
// content as a web page. The models are replaced with in-memory fakes BEFORE
// the controllers load, so these tests need no database.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

process.env.PUBLIC_APP_URL = 'https://warden.test';
delete process.env.VERCEL;

const { encryptFile } = require('../utils/crypto');
const limits = require('../utils/shareLimits');
const shareCrypto = require('../utils/shareCrypto');

// ---------- in-memory fakes ----------
const store = { documents: [], shares: [], files: [] };
const oid = () => new mongoose.Types.ObjectId();
const same = (a, b) => String(a) === String(b);

function stub(modulePath, exportsObject) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObject };
}

stub('../models/Document', {
  aggregate: async (pipeline) => {
    const ids = pipeline[0].$match._id.$in.map(String);
    const owner = pipeline[0].$match.userId;
    return store.documents
      .filter((doc) => ids.includes(String(doc._id)) && same(doc.userId, owner))
      .map((doc) => ({ _id: doc._id, size: doc.encryptedBlob.length }));
  },
  find: (query) => ({
    select: async () =>
      store.documents.filter(
        (doc) => query._id.$in.map(String).includes(String(doc._id)) && same(doc.userId, query.userId)
      ),
  }),
  findOne: (query) => ({
    select: async () => store.documents.find((doc) => same(doc._id, query._id) && same(doc.userId, query.userId)) || null,
  }),
});

const liveShares = (owner) =>
  store.shares.filter((share) => same(share.ownerUserId, owner) && share.expiresAt.getTime() > Date.now());

stub('../models/Share', {
  aggregate: async (pipeline) => {
    const owner = pipeline[0].$match.ownerUserId;
    const live = liveShares(owner);
    return live.length ? [{ _id: null, bytes: live.reduce((n, s) => n + s.totalBytes, 0), shares: live.length }] : [];
  },
  create: async (doc) => {
    store.shares.push({ ...doc, createdAt: new Date() });
    return doc;
  },
  find: (query) => ({
    select: () => ({
      sort: async () =>
        liveShares(query.ownerUserId).filter((share) => share.sourceDocumentIds.some((id) => same(id, query.sourceDocumentIds))),
    }),
  }),
  findOne: async (query) => store.shares.find((share) => share.shareId === query.shareId) || null,
  deleteOne: async (query) => {
    const before = store.shares.length;
    store.shares = store.shares.filter((s) => !(s.shareId === query.shareId && (!query.ownerUserId || same(s.ownerUserId, query.ownerUserId))));
    return { deletedCount: before - store.shares.length };
  },
  deleteMany: async () => ({}),
});

stub('../models/SharedFile', {
  insertMany: async (docs) => {
    store.files.push(...docs);
  },
  find: (query) => ({
    select: async () => store.files.filter((file) => file.shareId === query.shareId),
  }),
  findOne: async (query) => store.files.find((f) => f.shareId === query.shareId && f.fileId === query.fileId) || null,
  deleteMany: async (query) => {
    store.files = store.files.filter((file) => file.shareId !== query.shareId);
  },
});

const { createShare, createBulkShare, listShares, getUsage, revokeShare } = require('../controllers/shares.controller');
const { viewSharedManifest, viewSharedFile } = require('../controllers/sharedView.controller');

// ---------- helpers ----------
const DEK = crypto.randomBytes(32);
const ALICE = oid();
const BOB = oid();

function addDocument({ owner = ALICE, filename = 'passport.png', mimeType = 'image/png', content, folder = 'root' } = {}) {
  const plaintext = content ?? crypto.randomBytes(2048);
  const sealed = encryptFile(plaintext, DEK);
  const doc = {
    _id: oid(),
    userId: owner,
    filename,
    mimeType,
    folder,
    encryptedBlob: Buffer.from(sealed.ciphertext, 'base64'),
    iv: sealed.iv,
    authTag: sealed.authTag,
    checksum: crypto.createHash('sha256').update(plaintext).digest('hex'),
    plaintext,
  };
  store.documents.push(doc);
  return doc;
}

function reset() {
  store.documents = [];
  store.shares = [];
  store.files = [];
}

async function call(handler, { userId = ALICE, body = {}, params = {} } = {}) {
  const out = { status: null, json: null, headers: {}, body: null, error: null };
  const res = {
    setHeader(name, value) {
      out.headers[name.toLowerCase()] = value;
    },
    status(code) {
      out.status = code;
      return this;
    },
    json(payload) {
      out.json = payload;
      return this;
    },
    end(buffer) {
      out.body = buffer;
      return this;
    },
  };
  await handler({ userId, dek: DEK, body, params }, res, (err) => {
    out.error = err;
  });
  return out;
}

const fragmentKey = (shareUrl) => Buffer.from(new URL(shareUrl).hash.slice('#k='.length), 'base64url');

// ---------- crypto ----------
test('share crypto round-trips and is bound to its key, share id and slot', () => {
  const key = shareCrypto.generateShareKey();
  const sealed = shareCrypto.pack(shareCrypto.encryptForShare(Buffer.from('hello'), key, 'sid', 'file1'));
  assert.equal(shareCrypto.unpackAndDecrypt(sealed, key, 'sid', 'file1').toString(), 'hello');
  assert.throws(() => shareCrypto.unpackAndDecrypt(sealed, shareCrypto.generateShareKey(), 'sid', 'file1'), 'wrong key');
  assert.throws(() => shareCrypto.unpackAndDecrypt(sealed, key, 'other', 'file1'), 'wrong share id');
  assert.throws(() => shareCrypto.unpackAndDecrypt(sealed, key, 'sid', 'file2'), 'wrong slot');
  const tampered = Buffer.from(sealed);
  tampered[20] ^= 1;
  assert.throws(() => shareCrypto.unpackAndDecrypt(tampered, key, 'sid', 'file1'), 'tampered');
});

// ---------- creation ----------
test('creating a share stores ciphertext only and returns the key once, in the link fragment', async () => {
  reset();
  const doc = addDocument({ filename: 'Secret Tax Return 2024.pdf', mimeType: 'application/pdf', folder: 'Taxes' });
  const result = await call(createShare, { params: { id: String(doc._id) }, body: { durationHours: 24 } });
  assert.equal(result.error, null);
  assert.equal(result.status, 201);
  assert.equal(result.headers['cache-control'], 'no-store');

  const url = new URL(result.json.shareUrl);
  assert.equal(url.origin, 'https://warden.test', 'link comes from PUBLIC_APP_URL');
  assert.match(url.pathname, /^\/shared\/[0-9a-f]{32}$/);
  assert.match(url.hash, /^#k=[A-Za-z0-9_-]{43}$/);
  const key = fragmentKey(result.json.shareUrl);

  // What the database holds:
  const [share] = store.shares;
  const [file] = store.files;
  const everything = JSON.stringify([share, file]) + Buffer.concat([share.manifestCipher, file.ciphertext]).toString('latin1');
  assert.ok(!everything.includes(key.toString('base64')), 'no share key (base64)');
  assert.ok(!everything.includes(key.toString('hex')), 'no share key (hex)');
  assert.ok(!everything.includes(DEK.toString('hex')) && !everything.includes(DEK.toString('base64')), 'no vault key');
  assert.ok(!everything.includes('Secret Tax Return'), 'no plaintext file name');
  assert.ok(!everything.includes('Taxes') && !everything.includes('application/pdf'), 'no plaintext folder or type');
  assert.deepEqual(
    Object.keys(share).sort(),
    ['createdAt', 'expiresAt', 'fileCount', 'manifestAuthTag', 'manifestCipher', 'manifestIv', 'ownerUserId', 'shareId', 'sourceDocumentIds', 'totalBytes'].sort(),
    'the share record has exactly the allowed fields'
  );
  assert.equal(shareCrypto.SHARE_ID_RE.test(share.shareId), true);

  // The vault key cannot open the copies; the share key can.
  const blob = shareCrypto.pack(file);
  assert.throws(() => shareCrypto.unpackAndDecrypt(blob, DEK, share.shareId, file.fileId));
  assert.ok(shareCrypto.unpackAndDecrypt(blob, key, share.shareId, file.fileId).equals(doc.plaintext));
  const manifest = JSON.parse(
    shareCrypto
      .unpackAndDecrypt(shareCrypto.pack({ ciphertext: share.manifestCipher, iv: share.manifestIv, authTag: share.manifestAuthTag }), key, share.shareId, 'manifest')
      .toString()
  );
  assert.equal(manifest.files[0].name, 'Secret Tax Return 2024.pdf');
  assert.equal(manifest.files[0].folder, 'Taxes');
});

test('a multi-file share covers every file under one key', async () => {
  reset();
  const docs = [addDocument({ filename: 'a.png' }), addDocument({ filename: 'b.png' }), addDocument({ filename: 'c.png' })];
  const result = await call(createBulkShare, { body: { documentIds: docs.map((d) => String(d._id)), durationHours: 48 } });
  assert.equal(result.status, 201);
  assert.equal(result.json.entryCount, 3);
  assert.equal(store.files.length, 3);
  const key = fragmentKey(result.json.shareUrl);
  for (const file of store.files) {
    assert.ok(shareCrypto.unpackAndDecrypt(shareCrypto.pack(file), key, file.shareId, file.fileId));
  }
});

test('another account cannot share, list or revoke the first account\'s files and shares', async () => {
  reset();
  const doc = addDocument();
  const made = await call(createShare, { params: { id: String(doc._id) }, body: { durationHours: 24 } });
  const shareId = made.json.id;

  const steal = await call(createShare, { userId: BOB, params: { id: String(doc._id) }, body: { durationHours: 24 } });
  assert.equal(steal.error?.status, 404);
  const list = await call(listShares, { userId: BOB, params: { id: String(doc._id) } });
  assert.equal(list.error?.status, 404);
  const revoke = await call(revokeShare, { userId: BOB, params: { shareId } });
  assert.equal(revoke.error?.status, 404);
  assert.equal(store.shares.length, 1, 'still there');

  const own = await call(listShares, { params: { id: String(doc._id) } });
  assert.equal(own.json.length, 1);
  assert.deepEqual(Object.keys(own.json[0]).sort(), ['createdAt', 'entryCount', 'expiresAt', 'id']);
});

test('revoke deletes the share and its ciphertext copies; missing shares are a 404', async () => {
  reset();
  const doc = addDocument();
  const made = await call(createShare, { params: { id: String(doc._id) }, body: { durationHours: 24 } });
  const done = await call(revokeShare, { params: { shareId: made.json.id } });
  assert.equal(done.status, 200);
  assert.equal(store.shares.length, 0);
  assert.equal(store.files.length, 0);
  const again = await call(revokeShare, { params: { shareId: made.json.id } });
  assert.equal(again.error?.status, 404);
  const junk = await call(revokeShare, { params: { shareId: 'not-an-id' } });
  assert.equal(junk.error?.status, 404);
});

// ---------- limits ----------
test('limits: 30-day cap, 21st active share, 20MB per share, 60MB per user', async () => {
  reset();
  const doc = addDocument();
  const tooLong = await call(createShare, { params: { id: String(doc._id) }, body: { durationHours: 24 * 31 } });
  assert.equal(tooLong.error?.status, 400);
  assert.match(tooLong.error.message, /30 days/);
  const noDuration = await call(createShare, { params: { id: String(doc._id) }, body: {} });
  assert.equal(noDuration.status, 201, 'defaults to 7 days');
  assert.ok(Math.abs(new Date(noDuration.json.expiresAt) - (Date.now() + 7 * 24 * 3600 * 1000)) < 5000);

  reset();
  const small = addDocument();
  for (let i = 0; i < limits.MAX_ACTIVE_SHARES; i += 1) {
    const ok = await call(createShare, { params: { id: String(small._id) }, body: { durationHours: 24 } });
    assert.equal(ok.status, 201, `share ${i + 1}`);
  }
  const twentyFirst = await call(createShare, { params: { id: String(small._id) }, body: { durationHours: 24 } });
  assert.equal(twentyFirst.error?.status, 409);
  assert.match(twentyFirst.error.message, /20 active share links/);

  reset();
  const big = addDocument({ content: Buffer.alloc(4 * 1024 * 1024, 1) });
  const bigs = [big, ...Array.from({ length: 5 }, () => addDocument({ content: Buffer.alloc(4 * 1024 * 1024, 2) }))];
  const over = await call(createBulkShare, { body: { documentIds: bigs.map((d) => String(d._id)), durationHours: 24 } });
  assert.equal(over.error?.status, 413, '24MB in one share');
  assert.match(over.error.message, /at most 20MB/);
  assert.equal(store.shares.length, 0);

  // 20MB shares: three fit (60MB), the fourth does not.
  const five = bigs.slice(0, 5);
  for (let i = 0; i < 3; i += 1) {
    const ok = await call(createBulkShare, { body: { documentIds: five.map((d) => String(d._id)), durationHours: 24 } });
    assert.equal(ok.status, 201, `20MB share ${i + 1}`);
  }
  const usage = await call(getUsage);
  assert.equal(usage.json.usedBytes, 60 * 1024 * 1024);
  assert.equal(usage.json.remainingBytes, 0);
  const another = addDocument();
  const full = await call(createShare, { params: { id: String(another._id) }, body: { durationHours: 24 } });
  assert.equal(full.error?.status, 409);
  assert.match(full.error.message, /Not enough shared storage/);
});

// ---------- public side ----------
test('public endpoints serve ciphertext only, with no owner data, and identical generic errors', async () => {
  reset();
  const doc = addDocument();
  const made = await call(createShare, { params: { id: String(doc._id) }, body: { durationHours: 24 } });
  const shareId = made.json.id;

  const manifest = await call(viewSharedManifest, { params: { shareId } });
  assert.equal(manifest.status, 200);
  assert.deepEqual(Object.keys(manifest.json).sort(), ['expiresAt', 'files', 'manifest']);
  const text = JSON.stringify(manifest.json);
  assert.ok(!text.includes(String(ALICE)) && !text.includes(String(doc._id)), 'no owner or source document ids');
  assert.ok(!text.includes('passport'), 'no file name');

  // Expired (TTL has not reaped it yet), revoked/missing, malformed, and the old 64-hex token design:
  store.shares[0].expiresAt = new Date(Date.now() - 1000);
  const expired = await call(viewSharedManifest, { params: { shareId } });
  const missing = await call(viewSharedManifest, { params: { shareId: crypto.randomBytes(16).toString('hex') } });
  const legacy = await call(viewSharedManifest, { params: { shareId: crypto.randomBytes(32).toString('hex') } });
  const junk = await call(viewSharedManifest, { params: { shareId: '../../etc/passwd' } });
  for (const result of [expired, missing, legacy, junk]) {
    assert.equal(result.error.status, 404);
    assert.equal(result.error.message, 'This link is invalid or has expired.');
  }
});

test('no endpoint serves shared content inline or with an owner-controlled content type', async () => {
  reset();
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  const evilName = '<img src=x onerror=alert(1)>.html';
  const doc = addDocument({ filename: evilName, mimeType: 'text/html', content: html });
  const svg = addDocument({ filename: 'x.svg', mimeType: 'image/svg+xml', content: Buffer.from('<svg onload="alert(1)"/>') });
  const made = await call(createBulkShare, { body: { documentIds: [String(doc._id), String(svg._id)], durationHours: 24 } });
  const shareId = made.json.id;

  for (const file of store.files) {
    const served = await call(viewSharedFile, { params: { shareId, fileId: file.fileId } });
    assert.equal(served.status, 200);
    assert.equal(served.headers['content-type'], 'application/octet-stream', 'never the owner-supplied type');
    assert.match(served.headers['content-disposition'], /^attachment;/);
    assert.equal(served.headers['x-content-type-options'], 'nosniff');
    assert.equal(served.headers['cache-control'], 'no-store');
    assert.ok(!served.headers['content-disposition'].includes('onerror'), 'name never reaches a header');
    assert.ok(!served.body.includes('alert(1)') && !served.body.includes('<script'), 'ciphertext, not the file');
    assert.ok(served.body.equals(shareCrypto.pack(file)));
  }

  // And no server code path can do it: nothing under the share controllers
  // decrypts a shared file, sets a type from stored data, or sends inline.
  const view = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'sharedView.controller.js'), 'utf8');
  const withoutComments = view.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(withoutComments, /decryptFile|unpackAndDecrypt|createDecipheriv/, 'the server never decrypts shared content');
  assert.doesNotMatch(withoutComments, /\binline\b/i);
  assert.doesNotMatch(withoutComments, /res\.(type|contentType)\(/);
  for (const [, value] of withoutComments.matchAll(/setHeader\('Content-Type',\s*([^)]+)\)/g)) {
    assert.match(value.trim(), /^'application\/octet-stream'$/, 'Content-Type is only ever a literal');
  }
  const shares = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'shares.controller.js'), 'utf8');
  assert.doesNotMatch(shares.replace(/\/\*[\s\S]*?\*\//g, ''), /Content-Disposition|res\.send\(/, 'owner endpoints never stream a file');
});

test('the old token-based schema is gone', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'models', 'ShareToken.js')), false);
  for (const dir of ['controllers', 'routes', 'models', 'utils']) {
    for (const name of fs.readdirSync(path.join(__dirname, '..', dir))) {
      const text = fs.readFileSync(path.join(__dirname, '..', dir, name), 'utf8');
      assert.doesNotMatch(text, /wrappedDEKShare|ShareToken\b/, `${dir}/${name} still refers to the old share design`);
    }
  }
});
