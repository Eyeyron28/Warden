// Run with: cd server && npm test
//
// The removed drive backup / USB recovery (old URLs answer 410, nothing writes BackupLog any
// more) and the preview bookkeeping: what the bytes allow, and failures recorded so a file is
// not retried on every run.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

delete process.env.VERCEL;
process.env.NODE_ENV = 'test';

const db = require('./helpers/fakeDb');

const world = db.createWorld();
// The list is an aggregation; only the stages it uses are needed here.
const aggregate = (pipeline) => {
  const rows = world.tables.documents.filter((r) => db.matches(r, pipeline[0].$match));
  const q = { session: () => q, then: (ok, bad) => Promise.resolve(rows.map((r) => ({ ...r, size: r.encryptedBlob.length }))).then(ok, bad) };
  return q;
};
db.installModels(world, { Document: { aggregate } });
db.installRateLimit();
db.installMailer(world);

const { sniffPreviewKind } = require('../utils/sniff');
const { PREVIEW_FAILURE_REASONS } = require('../utils/thumbnails');
const D = require('../controllers/documents.controller');

const ALICE = db.oid();
const BOB = db.oid();
const DEK = crypto.randomBytes(32);
const as = (userId, extra = {}) => ({ userId, dek: DEK, ...extra });

function addDoc(userId, extra = {}) {
  const doc = {
    _id: db.oid(), userId, filename: 'a', folder: 'root', mimeType: 'application/octet-stream', deletedAt: null,
    encryptedBlob: Buffer.from('x'), iv: 'i', authTag: 't', checksum: 'c', previewKind: null, thumbFailedAt: null, thumbFailReason: null,
    createdAt: new Date(), updatedAt: new Date(), ...extra,
  };
  world.tables.documents.push(doc);
  return doc;
}
function reset() {
  for (const name of Object.keys(world.tables)) world.tables[name] = [];
}

// ------------------------------------------------------------------ removed features

test('the old backup, restore and USB-recovery URLs answer 410 and do nothing else', async () => {
  const express = require('express');
  const removed = require('../routes/removed.routes');
  const app = express();
  app.use('/api', removed);
  app.use((req, res) => res.status(404).json({ reached: 'the real routes' }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const call = (method, url) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: url, method }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(body) }));
      });
      req.on('error', reject);
      req.end(method === 'POST' ? '{}' : undefined);
    });
  try {
    for (const [method, url] of [
      ['POST', '/api/backup/export'], ['POST', '/api/backup/import'], ['GET', '/api/backup/status'], ['GET', '/api/backup'],
      ['POST', '/api/auth/recover-via-usb'],
    ]) {
      const out = await call(method, url);
      assert.equal(out.status, 410, `${method} ${url}`);
      assert.equal(out.json.success, false);
      assert.deepEqual(Object.keys(out.json.error), ['message']);
      assert.doesNotMatch(out.json.error.message, /path|passphrase|manifest/i);
    }
    assert.equal((await call('GET', '/api/documents')).status, 404, 'other URLs are not caught');
  } finally {
    server.close();
  }
});

test('nothing in the server writes backups, reads a server path, or offers USB recovery any more', () => {
  const root = path.join(__dirname, '..');
  assert.ok(!fs.existsSync(path.join(root, 'controllers', 'backup.controller.js')));
  assert.ok(!fs.existsSync(path.join(root, 'routes', 'backup.routes.js')));
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'test') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(root);
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const name = path.relative(root, file);
    // (a developer-run script that can save sample email files; it never runs as part of the server)
    if (name === path.join('scripts', 'send-test-emails.js')) continue;
    assert.doesNotMatch(source, /BackupLog\.(create|insertMany|save)|new BackupLog/, `${name}: no BackupLog writes`);
    assert.doesNotMatch(source, /usbPassphrase|wrappedDEKUsb|recoverViaUsb\b|\bfs\.(writeFile|mkdir|readdir)/, name);
    if (name !== path.join('routes', 'removed.routes.js')) assert.doesNotMatch(source, /recover-via-usb|api\/backup/, name);
  }
  // The model stays only so existing rows can be removed with the account and by a wipe.
  assert.ok(fs.existsSync(path.join(root, 'models', 'BackupLog.js')));
  const deletion = fs.readFileSync(path.join(root, 'utils', 'accountDeletion.js'), 'utf8');
  assert.match(deletion, /BackupLog/);
  assert.match(fs.readFileSync(path.join(root, 'utils', 'accountReset.js'), 'utf8'), /BackupLog\.deleteMany/);
});

// ------------------------------------------------------------------ preview eligibility

test('what the bytes allow: image, pdf or none - never decided by a name', () => {
  const pad = (bytes) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(32)]);
  assert.equal(sniffPreviewKind(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image');
  assert.equal(sniffPreviewKind(pad([0xff, 0xd8, 0xff, 0xe0])), 'image');
  assert.equal(sniffPreviewKind(Buffer.from('GIF89a-and-more-bytes')), 'image');
  assert.equal(sniffPreviewKind(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'image');
  assert.equal(sniffPreviewKind(Buffer.from('%PDF-1.7\nrest')), 'pdf');
  assert.equal(sniffPreviewKind(Buffer.from('junk\n%PDF-1.4 after a little junk')), 'pdf');
  for (const none of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), Buffer.from('ftypheic0000000000'), Buffer.from('plain text'), Buffer.alloc(0), 'x', null]) {
    assert.equal(sniffPreviewKind(none), 'none');
  }
  const upload = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'documents.controller.js'), 'utf8');
  assert.match(upload, /previewKind: sniffPreviewKind\(buffer\)/, 'classified from the bytes at upload');
});

// ------------------------------------------------------------------ recorded failures

test('a failed preview is recorded with a reason code, shown in the list, and cleared by a retry', async () => {
  reset();
  const mine = addDoc(ALICE, { filename: 'corrupt.png' });
  const theirs = addDoc(BOB, { filename: 'theirs.png' });

  const ok = await db.call(D.markThumbnailFailed, { ...as(ALICE), params: { id: String(mine._id) }, body: { reason: 'decode-failed', kind: 'image' } });
  assert.equal(ok.status, 200);
  assert.equal(mine.thumbFailReason, 'decode-failed');
  assert.ok(mine.thumbFailedAt instanceof Date);
  assert.equal(mine.previewKind, 'image');

  const listed = (await db.call(D.listDocuments, as(ALICE))).json.find((d) => String(d.id) === String(mine._id));
  assert.equal(listed.thumbFailed, true);
  assert.equal(listed.thumbFailReason, 'decode-failed');
  assert.equal(listed.previewKind, 'image');

  // an unsupported type also takes the file out of the "could have a preview" count
  const heic = addDoc(ALICE, { filename: 'photo.heic' });
  await db.call(D.markThumbnailFailed, { ...as(ALICE), params: { id: String(heic._id) }, body: { reason: 'unsupported-type' } });
  assert.equal(heic.previewKind, 'none');

  // bad input, other accounts, and trashed files
  for (const body of [{}, { reason: 'because I said so' }, { reason: 5 }, { reason: ['decode-failed'] }]) {
    assert.equal((await db.call(D.markThumbnailFailed, { ...as(ALICE), params: { id: String(mine._id) }, body })).error.status, 400);
  }
  assert.equal((await db.call(D.markThumbnailFailed, { ...as(ALICE), params: { id: String(theirs._id) }, body: { reason: 'timeout' } })).error.status, 404);
  assert.equal(theirs.thumbFailedAt, null);
  const trashed = addDoc(ALICE, { deletedAt: new Date() });
  assert.equal((await db.call(D.markThumbnailFailed, { ...as(ALICE), params: { id: String(trashed._id) }, body: { reason: 'timeout' } })).error.status, 404);
  assert.deepEqual(PREVIEW_FAILURE_REASONS.slice().sort(), ['decode-failed', 'download-failed', 'timeout', 'too-big-result', 'too-large', 'unsupported-type']);

  // retry forgets MY failures only
  await db.call(D.markThumbnailFailed, { ...as(BOB), params: { id: String(theirs._id) }, body: { reason: 'timeout' } });
  const retried = await db.call(D.retryFailedThumbnails, as(ALICE));
  assert.equal(retried.status, 200);
  assert.equal(mine.thumbFailedAt, null);
  assert.equal(mine.thumbFailReason, null);
  assert.ok(theirs.thumbFailedAt, "Bob's record is untouched");
});

test('storing a preview forgets an earlier failure', async () => {
  reset();
  const doc = addDoc(ALICE, { thumbFailedAt: new Date(), thumbFailReason: 'timeout', save: async function save() { return this; }, set(fields) { Object.assign(this, fields); } });
  world.tables.documents = [doc];
  const thumb = { buffer: Buffer.alloc(2000, 7), mimetype: 'image/webp' };
  const out = await db.call(D.putThumbnail, { ...as(ALICE), params: { id: String(doc._id) }, files: { thumb: [thumb] } });
  assert.equal(out.status, 200);
  assert.equal(doc.thumbFailedAt, null);
  assert.equal(doc.thumbFailReason, null);
  assert.equal(doc.thumbMime, 'image/webp');
  assert.ok(doc.previewKind);
});
