// Run with: cd server && npm test   (Node's built-in test runner, no deps)
//
// Trash (soft delete, restore, purge), the Photos classification by sniffed
// type, and per-account isolation of all of it. Models are in-memory fakes
// installed before the code under test loads.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

process.env.PUBLIC_APP_URL = 'https://warden.test';
delete process.env.VERCEL;
process.env.NODE_ENV = 'test';

const { encryptFile } = require('../utils/crypto');
const db = require('./helpers/fakeDb');
const { sniffImageType, IMAGE_TYPES } = require('../utils/sniff');

const world = db.createWorld();
const ALICE = db.oid();
const BOB = db.oid();
const DEK = crypto.randomBytes(32);
const DAY = 24 * 3600 * 1000;

// A tiny aggregation engine for the pipelines the code under test uses.
function runPipeline(rows, pipeline) {
  let current = rows;
  for (const stage of pipeline) {
    if (stage.$match) current = current.filter((r) => db.matches(r, stage.$match));
    else if (stage.$sort) current = [...current].sort((a, b) => b.createdAt - a.createdAt);
    else if (stage.$project) {
      current = current.map((r) => {
        const out = { _id: r._id };
        for (const [field, spec] of Object.entries(stage.$project)) {
          out[field] = spec === 1 ? r[field] : r.encryptedBlob.length; // the only computed field is size
        }
        return out;
      });
    } else if (stage.$group) {
      // Only the shape the code uses: one group over everything that matched, summing blob sizes.
      current = [{ _id: null, bytes: current.reduce((n, r) => n + r.encryptedBlob.length, 0), count: current.length }];
    }
  }
  return current;
}
const documentAggregate = (pipeline) => {
  const q = { session: () => q, then: (ok, bad) => Promise.resolve(runPipeline(world.tables.documents, pipeline)).then(ok, bad) };
  return q;
};

db.installModels(world, { Document: { aggregate: documentAggregate } });
db.installRateLimit();
db.installMailer(world);

// Folder helpers: the real path logic, with an in-memory ensureFolderPath and no real transaction.
const folders = require('../utils/folders');
folders.runInTransaction = async (fn) => fn(null);
folders.ensureFolderPath = async (userId, folderPath) => {
  let current = '';
  for (const segment of folders.splitPath(folderPath)) {
    const existing = world.tables.folders.find((f) => String(f.userId) === String(userId) && f.parentPath === current && f.nameKey === folders.toNameKey(segment));
    if (existing) current = folders.fullPathOf(existing);
    else {
      world.tables.folders.push({ _id: db.oid(), userId, parentPath: current, name: segment, nameKey: folders.toNameKey(segment) });
      current = folders.joinPath(current, segment);
    }
  }
  return current;
};

const trash = require('../utils/trash');
const D = require('../controllers/documents.controller');
const T = require('../controllers/trash.controller');
const S = require('../controllers/shares.controller');
const { call } = db;

// ---------- fixtures ----------
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(40)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(40)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), crypto.randomBytes(40)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBP'), crypto.randomBytes(40)]);

function reset() {
  for (const name of Object.keys(world.tables)) world.tables[name] = [];
  world.mails = [];
}

function addFolder(userId, folderPath) {
  return folders.ensureFolderPath(userId, folderPath);
}

function addDoc({ userId = ALICE, filename = 'a.txt', folder = 'root', content = crypto.randomBytes(64), sniffedType = undefined, createdAt = new Date(), encrypt = false } = {}) {
  let blob = content;
  let iv = 'iv';
  let authTag = 'tag';
  if (encrypt) {
    const sealed = encryptFile(content, DEK);
    blob = Buffer.from(sealed.ciphertext, 'base64');
    iv = sealed.iv;
    authTag = sealed.authTag;
  }
  const doc = {
    _id: db.oid(), userId, filename, folder, encryptedBlob: blob, iv, authTag, checksum: 'x', mimeType: 'application/octet-stream',
    thumbMime: 'image/webp', thumbCipher: Buffer.alloc(8), deletedAt: null, purgeAt: null, trashBatchId: null,
    sniffedType: sniffedType === undefined ? null : sniffedType, createdAt, updatedAt: createdAt,
  };
  world.tables.documents.push(doc);
  return doc;
}

const as = (userId, extra = {}) => ({ userId, dek: DEK, ...extra });
const live = (userId = ALICE) => world.tables.documents.filter((d) => String(d.userId) === String(userId) && !d.deletedAt);
const names = (rows) => rows.map((r) => r.filename).sort();

// ---------- sniffing ----------
test('image sniffing goes by bytes, never by name or claimed type', () => {
  assert.equal(sniffImageType(PNG), 'image/png');
  assert.equal(sniffImageType(JPEG), 'image/jpeg');
  assert.equal(sniffImageType(GIF), 'image/gif');
  assert.equal(sniffImageType(WEBP), 'image/webp');
  assert.deepEqual(IMAGE_TYPES.sort(), ['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
  for (const notImage of [
    Buffer.from('this is notes.png but really text, long enough'),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
    Buffer.from('<html><script>alert(1)</script></html>'),
    Buffer.from('%PDF-1.4 something'),
    Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt '),
    Buffer.from('GIF9x'),
    Buffer.alloc(0),
    Buffer.alloc(5),
    'a string',
    null,
  ]) {
    assert.equal(sniffImageType(notImage), 'none');
  }
  // A PNG signature with a .txt name is still a PNG; a text file named .png is not.
  assert.equal(sniffImageType(PNG), 'image/png');
});

// ---------- photos ----------
test('Photos lists only sniffed images from every folder, newest first, and classifies old files lazily', async () => {
  reset();
  await addFolder(ALICE, 'Trips');
  const t = (daysAgo) => new Date(Date.now() - daysAgo * DAY);
  addDoc({ filename: 'holiday.png', folder: 'Trips', content: PNG, encrypt: true, createdAt: t(10) });
  addDoc({ filename: 'renamed-from-png.txt', content: PNG, encrypt: true, createdAt: t(5) }); // a PNG named .txt
  addDoc({ filename: 'notes.png', content: Buffer.from('plain text pretending to be a picture, definitely not one'), encrypt: true, createdAt: t(3) });
  addDoc({ filename: 'icon.svg', content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>'), encrypt: true, createdAt: t(2) });
  addDoc({ filename: 'selfie.jpg', content: JPEG, encrypt: true, createdAt: t(1) });
  addDoc({ filename: 'gone.png', content: PNG, encrypt: true, createdAt: t(0) });
  addDoc({ filename: 'bobs.png', userId: BOB, content: PNG, encrypt: true });
  // already classified at upload, no decrypting needed
  addDoc({ filename: 'fresh.webp', content: WEBP, encrypt: true, sniffedType: 'image/webp', createdAt: t(20) });

  await trash.trashDocument(ALICE, world.tables.documents.find((d) => d.filename === 'gone.png')._id);

  const first = await call(D.listPhotos, as(ALICE));
  assert.equal(first.error, null);
  assert.equal(first.json.pending, 0, 'all 6 live legacy files fit in one classification batch');
  assert.deepEqual(first.json.photos.map((p) => p.filename), ['selfie.jpg', 'renamed-from-png.txt', 'holiday.png', 'fresh.webp'], 'newest first');
  assert.ok(!first.json.photos.some((p) => ['notes.png', 'icon.svg', 'gone.png', 'bobs.png'].includes(p.filename)));
  assert.deepEqual(first.json.photos.map((p) => p.sniffedType), ['image/jpeg', 'image/png', 'image/png', 'image/webp']);
  // what the files are stored as is the sniffed answer
  assert.equal(world.tables.documents.find((d) => d.filename === 'notes.png').sniffedType, 'none');
  assert.equal(world.tables.documents.find((d) => d.filename === 'icon.svg').sniffedType, 'none');
  for (const photo of first.json.photos) {
    assert.ok(typeof photo.size === 'number' && photo.size > 0);
    assert.equal(photo.hasThumb, true);
  }
  assert.ok(!JSON.stringify(first.json).includes('encryptedBlob'));
});

test('Photos classifies a large backlog a batch at a time and reports what is pending', async () => {
  reset();
  for (let i = 0; i < 30; i += 1) addDoc({ filename: `p${i}.png`, content: PNG, encrypt: true, createdAt: new Date(Date.now() - i * 1000) });
  const one = await call(D.listPhotos, as(ALICE));
  assert.equal(one.json.photos.length, 12);
  assert.equal(one.json.pending, 18);
  await call(D.listPhotos, as(ALICE));
  const three = await call(D.listPhotos, as(ALICE));
  assert.equal(three.json.pending, 0);
  assert.equal(three.json.photos.length, 30);
});

// ---------- the vault list ----------
test('the document list hides Trash and carries size and type fields', async () => {
  reset();
  const keep = addDoc({ filename: 'keep.png', content: PNG, sniffedType: 'image/png' });
  const gone = addDoc({ filename: 'gone.pdf' });
  await trash.trashDocument(ALICE, gone._id);
  const list = await call(D.listDocuments, as(ALICE));
  assert.deepEqual(list.json.map((d) => d.filename), ['keep.png']);
  assert.equal(list.json[0].size, PNG.length);
  assert.equal(list.json[0].sniffedType, 'image/png');
  assert.ok(list.json[0].updatedAt);
  const storage = await call(D.getStorage, as(ALICE));
  assert.equal(storage.json.fileBytes, keep.encryptedBlob.length);
  assert.equal(storage.json.fileCount, 1);
  assert.equal(storage.json.trashBytes, gone.encryptedBlob.length);
  assert.equal(storage.json.trashCount, 1);
  assert.equal(storage.json.usedBytes, keep.encryptedBlob.length + gone.encryptedBlob.length);
});

// ---------- trashing a file ----------
test('deleting a file moves it to Trash, keeps its ciphertext and stops its shares at that moment', async () => {
  reset();
  const doc = addDoc({ filename: 'lease.pdf', folder: 'root' });
  const other = addDoc({ filename: 'other.pdf' });
  // A share covering both files, and a share of only the other file.
  world.tables.shares.push({ _id: db.oid(), shareId: 'a'.repeat(32), ownerUserId: ALICE, sourceDocumentIds: [doc._id, other._id] });
  world.tables.sharedfiles.push({ _id: db.oid(), shareId: 'a'.repeat(32), fileId: 'f1' });
  world.tables.shares.push({ _id: db.oid(), shareId: 'b'.repeat(32), ownerUserId: ALICE, sourceDocumentIds: [other._id] });
  world.tables.sharedfiles.push({ _id: db.oid(), shareId: 'b'.repeat(32), fileId: 'f2' });
  const blob = doc.encryptedBlob;

  const result = await call(D.deleteDocument, { ...as(ALICE), params: { id: String(doc._id) } });
  assert.equal(result.status, 204);
  assert.equal(world.tables.documents.length, 2, 'not removed');
  assert.ok(doc.deletedAt instanceof Date);
  assert.ok(doc.encryptedBlob.equals(blob), 'ciphertext untouched');
  assert.ok(Math.abs(doc.purgeAt - (Date.now() + 30 * DAY)) < 5000, 'purge in 30 days');
  assert.deepEqual(world.tables.shares.map((s) => s.shareId), ['b'.repeat(32)], 'the share that included it is gone at once');
  assert.deepEqual(world.tables.sharedfiles.map((f) => f.shareId), ['b'.repeat(32)]);

  // Gone from every route that serves live documents.
  const view = await call(D.viewDocument, { ...as(ALICE), params: { id: String(doc._id) } });
  assert.equal(view.error.status, 404);
  assert.equal((await call(D.getThumbnail, { ...as(ALICE), params: { id: String(doc._id) } })).error.status, 404);
  assert.equal((await call(D.updateDocument, { ...as(ALICE), params: { id: String(doc._id) }, body: { filename: 'x.pdf' } })).error.status, 404);
  assert.equal((await call(D.deleteDocument, { ...as(ALICE), params: { id: String(doc._id) } })).error.status, 404, 'already in Trash');
  const share = await call(S.createShare, { ...as(ALICE), params: { id: String(doc._id) }, body: { durationHours: 1 } });
  assert.equal(share.error.status, 404, 'not available for sharing');
  const bulk = await call(S.createBulkShare, { ...as(ALICE), body: { documentIds: [String(doc._id)], durationHours: 1 } });
  assert.equal(bulk.error.status, 404);
});

test('what the document view serves is opaque bytes, never typed or inline', async () => {
  reset();
  const doc = addDoc({ filename: '<img src=x onerror=alert(1)>.html', content: Buffer.from('<html><script>alert(1)</script></html>'), encrypt: true });
  doc.checksum = crypto.createHash('sha256').update(Buffer.from('<html><script>alert(1)</script></html>')).digest('hex');
  doc.mimeType = 'text/html';
  const served = await call(D.viewDocument, { ...as(ALICE), params: { id: String(doc._id) } });
  assert.equal(served.error, null);
  assert.equal(served.headers['content-type'], 'application/octet-stream', 'never the owner-claimed type');
  assert.match(served.headers['content-disposition'], /^attachment;/);
  assert.ok(!served.headers['content-disposition'].includes('<'), 'the name is encoded in the header');
  assert.equal(served.headers['x-content-type-options'], 'nosniff');
  assert.equal(served.headers['cache-control'], 'no-store');
});

// ---------- the Trash list ----------
test('Trash lists files and folders with location, date and days left', async () => {
  reset();
  await addFolder(ALICE, 'Taxes/2024');
  const file = addDoc({ filename: 'w2.pdf', folder: 'Taxes/2024' });
  const loose = addDoc({ filename: 'loose.txt' });
  await trash.trashDocument(ALICE, file._id);
  await trash.trashDocument(ALICE, loose._id);
  addDoc({ filename: 'in-old.txt', folder: 'Old' });
  await addFolder(ALICE, 'Old');
  await call(D.deleteFolder, { ...as(ALICE), query: { path: 'Old' } });

  const listed = await call(T.listTrash, as(ALICE));
  assert.equal(listed.json.retentionDays, 30);
  assert.equal(listed.json.items.length, 3, 'two files and one folder; the folder file is inside the folder entry');
  const w2 = listed.json.items.find((i) => i.name === 'w2.pdf');
  assert.equal(w2.kind, 'file');
  assert.equal(w2.originalLocation, 'Taxes/2024');
  assert.equal(w2.daysLeft, 30);
  assert.ok(w2.deletedAt && w2.size > 0);
  const old = listed.json.items.find((i) => i.name === 'Old');
  assert.equal(old.kind, 'folder');
  assert.equal(old.itemCount, 1);
  assert.equal(old.originalLocation, '');
  assert.ok(!listed.json.items.some((i) => i.name === 'in-old.txt'));
  assert.ok(!JSON.stringify(listed.json).includes('encryptedBlob'));
});

// ---------- folders ----------
test('a folder is trashed with its contents as one entry, and restored together', async () => {
  reset();
  await addFolder(ALICE, 'Taxes/2024');
  await addFolder(ALICE, 'Taxes/Empty');
  const a = addDoc({ filename: 'a.pdf', folder: 'Taxes' });
  const b = addDoc({ filename: 'b.pdf', folder: 'Taxes/2024' });
  const outside = addDoc({ filename: 'outside.pdf', folder: 'root' });
  world.tables.shares.push({ _id: db.oid(), shareId: 'c'.repeat(32), ownerUserId: ALICE, sourceDocumentIds: [b._id] });
  world.tables.sharedfiles.push({ _id: db.oid(), shareId: 'c'.repeat(32), fileId: 'f' });

  const result = await call(D.deleteFolder, { ...as(ALICE), query: { path: 'taxes' } }); // case-insensitive, like everywhere
  assert.equal(result.status, 204);
  assert.deepEqual(names(live()), ['outside.pdf'], 'both documents left the vault together');
  assert.equal(world.tables.folders.filter((f) => String(f.userId) === String(ALICE)).length, 0, 'folder records are out of the vault');
  assert.equal(world.tables.trashfolders.length, 1);
  assert.equal(world.tables.shares.length, 0, 'shares of anything inside are stopped');
  assert.deepEqual(world.tables.trashfolders[0].subPaths.sort(), ['Taxes', 'Taxes/2024', 'Taxes/Empty']);
  assert.equal(world.tables.trashfolders[0].itemCount, 2);
  assert.ok(world.tables.documents.filter((d) => d.trashBatchId).every((d) => d.purgeAt && d.deletedAt));

  // The name can be reused while the old one is in Trash.
  await addFolder(ALICE, 'Taxes');
  assert.equal(world.tables.folders.length, 1);
  world.tables.folders.length = 0; // remove it again for the restore below

  const [item] = (await call(T.listTrash, as(ALICE))).json.items;
  const restored = await call(T.restoreItem, { ...as(ALICE), body: { kind: 'folder', id: item.id } });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.message, null);
  assert.deepEqual(names(live()), ['a.pdf', 'b.pdf', 'outside.pdf']);
  assert.equal(world.tables.documents.find((d) => d.filename === 'b.pdf').folder, 'Taxes/2024');
  assert.equal(world.tables.documents.find((d) => d.filename === 'a.pdf').folder, 'Taxes');
  assert.deepEqual(world.tables.folders.map((f) => folders.fullPathOf(f)).sort(), ['Taxes', 'Taxes/2024', 'Taxes/Empty'], 'including the empty subfolder');
  assert.equal(world.tables.trashfolders.length, 0);
  assert.ok(world.tables.documents.every((d) => !d.deletedAt && !d.trashBatchId && !d.purgeAt));
  assert.ok(outside);
});

test('deleting a folder that is not there is a success and changes nothing', async () => {
  reset();
  addDoc({ filename: 'x.txt' });
  const r = await call(D.deleteFolder, { ...as(ALICE), query: { path: 'Nope' } });
  assert.equal(r.status, 204);
  assert.equal(world.tables.trashfolders.length, 0);
  assert.equal(live().length, 1);
});

// ---------- restore rules ----------
test('restore: original folder gone -> top level with a message; name taken -> top level; taken there too -> 409', async () => {
  reset();
  // 1. original folder deleted while the file was in Trash
  await addFolder(ALICE, 'Projects');
  const one = addDoc({ filename: 'plan.pdf', folder: 'Projects' });
  await trash.trashDocument(ALICE, one._id);
  world.tables.folders.length = 0;
  const r1 = await call(T.restoreItem, { ...as(ALICE), body: { kind: 'file', id: String(one._id) } });
  assert.equal(r1.json.restoredTo, '');
  assert.match(r1.json.message, /no longer exists/);
  assert.equal(one.folder, 'root');
  assert.equal(one.deletedAt, null);

  // 2. a file with that name was created in the original folder in the meantime
  await addFolder(ALICE, 'Docs');
  const two = addDoc({ filename: 'a.pdf', folder: 'Docs' });
  await trash.trashDocument(ALICE, two._id);
  addDoc({ filename: 'a.pdf', folder: 'Docs' });
  const r2 = await call(T.restoreItem, { ...as(ALICE), body: { kind: 'file', id: String(two._id) } });
  assert.equal(r2.json.restoredTo, '');
  assert.match(r2.json.message, /already exists in the original folder/);
  assert.equal(two.folder, 'root');

  // 3. taken at the top level too: 409 and nothing changes
  const three = addDoc({ filename: 'b.pdf', folder: 'Docs' });
  await trash.trashDocument(ALICE, three._id);
  addDoc({ filename: 'b.pdf', folder: 'Docs' });
  addDoc({ filename: 'b.pdf', folder: 'root' });
  const r3 = await call(T.restoreItem, { ...as(ALICE), body: { kind: 'file', id: String(three._id) } });
  assert.equal(r3.error.status, 409);
  assert.equal(r3.error.code, 'NAME_EXISTS');
  assert.ok(three.deletedAt, 'still in Trash');

  // 4. original at the top level and name taken there -> 409
  const four = addDoc({ filename: 'c.pdf', folder: 'root' });
  await trash.trashDocument(ALICE, four._id);
  addDoc({ filename: 'c.pdf', folder: 'root' });
  assert.equal((await call(T.restoreItem, { ...as(ALICE), body: { kind: 'file', id: String(four._id) } })).error.status, 409);
});

test('restoring a folder: parent gone -> top level; a folder with that name there -> 409 FOLDER_EXISTS', async () => {
  reset();
  await addFolder(ALICE, 'Outer/Inner');
  addDoc({ filename: 'x.txt', folder: 'Outer/Inner' });
  await call(D.deleteFolder, { ...as(ALICE), query: { path: 'Outer/Inner' } });
  world.tables.folders.length = 0; // "Outer" is deleted too
  const [item] = (await call(T.listTrash, as(ALICE))).json.items;
  assert.equal(item.originalLocation, 'Outer');

  await addFolder(ALICE, 'Inner'); // a folder with that name now exists at the top level
  const clash = await call(T.restoreItem, { ...as(ALICE), body: { kind: 'folder', id: item.id } });
  assert.equal(clash.error.status, 409);
  assert.equal(clash.error.code, 'FOLDER_EXISTS');
  assert.equal(world.tables.trashfolders.length, 1, 'unchanged');

  world.tables.folders.length = 0;
  const ok = await call(T.restoreItem, { ...as(ALICE), body: { kind: 'folder', id: item.id } });
  assert.equal(ok.json.restoredTo, '');
  assert.match(ok.json.message, /no longer exists/);
  assert.equal(world.tables.documents[0].folder, 'Inner', 'its contents came back under the new place');
  assert.deepEqual(world.tables.folders.map((f) => folders.fullPathOf(f)), ['Inner']);
});

// ---------- permanent deletion, emptying, purging ----------
test('permanent delete and Empty trash remove the encrypted data and thumbnail', async () => {
  reset();
  const a = addDoc({ filename: 'a.txt' });
  const b = addDoc({ filename: 'b.txt' });
  addDoc({ filename: 'keep.txt' });
  await addFolder(ALICE, 'F');
  addDoc({ filename: 'in-f.txt', folder: 'F' });
  addDoc({ filename: 'in-f2.txt', folder: 'F' });
  await trash.trashDocument(ALICE, a._id);
  await trash.trashDocument(ALICE, b._id);
  await call(D.deleteFolder, { ...as(ALICE), query: { path: 'F' } });
  assert.equal(world.tables.documents.length, 5);

  const gone = await call(T.deleteItem, { ...as(ALICE), params: { kind: 'file', id: String(a._id) } });
  assert.equal(gone.status, 204);
  assert.ok(!world.tables.documents.some((d) => String(d._id) === String(a._id)), 'the whole document, blob and thumbnail, is gone');
  assert.equal((await call(T.deleteItem, { ...as(ALICE), params: { kind: 'file', id: String(a._id) } })).error.status, 404);
  assert.equal((await call(T.deleteItem, { ...as(ALICE), params: { kind: 'bogus', id: 'x' } })).error.status, 400);

  const [folderItem] = (await call(T.listTrash, as(ALICE))).json.items.filter((i) => i.kind === 'folder');
  assert.equal((await call(T.deleteItem, { ...as(ALICE), params: { kind: 'folder', id: folderItem.id } })).status, 204);
  assert.deepEqual(names(world.tables.documents), ['b.txt', 'keep.txt'], 'the folder entry and both its files are gone');
  assert.equal(world.tables.trashfolders.length, 0);

  const emptied = await call(T.emptyTrash, as(ALICE));
  assert.equal(emptied.status, 200);
  assert.deepEqual(names(world.tables.documents), ['keep.txt'], 'only live documents remain');
});

test('items older than 30 days are purged, on request and by the sweep, with a folder taking its files along', async () => {
  reset();
  const old = addDoc({ filename: 'old.txt' });
  const fresh = addDoc({ filename: 'fresh.txt' });
  await trash.trashDocument(ALICE, old._id);
  await trash.trashDocument(ALICE, fresh._id);
  await addFolder(ALICE, 'OldFolder');
  addDoc({ filename: 'old-in-folder.txt', folder: 'OldFolder' });
  await call(D.deleteFolder, { ...as(ALICE), query: { path: 'OldFolder' } });
  addDoc({ filename: 'bobs-old.txt', userId: BOB });
  await trash.trashDocument(BOB, world.tables.documents.find((d) => d.filename === 'bobs-old.txt')._id);

  // 31 days later: everything trashed "yesterday" is expired for those that were trashed 31 days ago
  const past = new Date(Date.now() - 1000);
  old.purgeAt = past;
  world.tables.trashfolders[0].purgeAt = past;
  world.tables.documents.filter((d) => d.trashBatchId).forEach((d) => { d.purgeAt = past; });

  const listed = await call(T.listTrash, as(ALICE)); // opportunistic purge on the owner's own request
  assert.deepEqual(listed.json.items.map((i) => i.name), ['fresh.txt']);
  assert.deepEqual(names(world.tables.documents), ['bobs-old.txt', 'fresh.txt']);
  assert.equal(world.tables.trashfolders.length, 0);

  // The sweep covers every account.
  world.tables.documents.find((d) => d.filename === 'bobs-old.txt').purgeAt = past;
  const swept = await trash.purgeExpired();
  assert.equal(swept.deletedDocuments, 1);
  assert.deepEqual(names(world.tables.documents), ['fresh.txt']);

  const dry = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'purge-trash.js'), 'utf8');
  assert.match(dry, /DRY RUN/);
  assert.match(dry, /process\.argv\.includes\('--confirm'\)/);
});

// ---------- isolation ----------
test("another account's files and folders are 404 for trash, restore, permanent delete and the list", async () => {
  reset();
  await addFolder(ALICE, 'Private');
  const mine = addDoc({ filename: 'mine.txt', folder: 'Private' });
  const trashed = addDoc({ filename: 'trashed.txt' });
  await trash.trashDocument(ALICE, trashed._id);
  await call(D.deleteFolder, { ...as(ALICE), query: { path: 'Private' } });
  const [folderItem] = (await call(T.listTrash, as(ALICE))).json.items.filter((i) => i.kind === 'folder');

  // Bob cannot trash alice's file or folder
  addDoc({ filename: 'bobs.txt', userId: BOB });
  const live1 = addDoc({ filename: 'alice-live.txt' });
  assert.equal((await call(D.deleteDocument, { ...as(BOB), params: { id: String(live1._id) } })).error.status, 404);
  assert.equal(live1.deletedAt, null);
  await addFolder(ALICE, 'Other');
  assert.equal((await call(D.deleteFolder, { ...as(BOB), query: { path: 'Other' } })).status, 204, 'idempotent: for bob there is no such folder');
  assert.ok(world.tables.folders.some((f) => f.name === 'Other'), "alice's folder untouched");

  // ...nor see, restore or purge her Trash
  assert.deepEqual((await call(T.listTrash, as(BOB))).json.items, []);
  for (const [name, body] of [
    ['restore file', { kind: 'file', id: String(trashed._id) }],
    ['restore folder', { kind: 'folder', id: folderItem.id }],
  ]) {
    assert.equal((await call(T.restoreItem, { ...as(BOB), body })).error.status, 404, name);
  }
  assert.equal((await call(T.deleteItem, { ...as(BOB), params: { kind: 'file', id: String(trashed._id) } })).error.status, 404);
  assert.equal((await call(T.deleteItem, { ...as(BOB), params: { kind: 'folder', id: folderItem.id } })).error.status, 404);
  const bobEmpties = await call(T.emptyTrash, as(BOB));
  assert.equal(bobEmpties.json.deletedDocuments, 0);
  assert.equal(world.tables.trashfolders.length, 1, "alice's trashed folder survived bob emptying his trash");
  assert.ok(world.tables.documents.some((d) => String(d._id) === String(trashed._id)));
  assert.ok(mine);

  // and her view/photos/storage never include bob's
  assert.equal((await call(D.viewDocument, { ...as(BOB), params: { id: String(trashed._id) } })).error.status, 404);
  assert.ok((await call(D.listDocuments, as(BOB))).json.every((d) => d.filename === 'bobs.txt'));
});

test('folder children are lazy, scoped to the account and never include Trash', async () => {
  reset();
  await addFolder(ALICE, 'Taxes/2024');
  await addFolder(ALICE, 'Taxes/2023');
  await addFolder(ALICE, 'Photos');
  await addFolder(BOB, 'Secret');
  const top = await call(D.listFolderChildren, { ...as(ALICE), query: { path: '' } });
  assert.deepEqual(top.json.folders.map((f) => [f.name, f.hasChildren]), [['Photos', false], ['Taxes', true]]);
  const taxes = await call(D.listFolderChildren, { ...as(ALICE), query: { path: 'taxes' } });
  assert.equal(taxes.json.path, 'Taxes');
  assert.deepEqual(taxes.json.folders.map((f) => f.path), ['Taxes/2023', 'Taxes/2024']);
  assert.equal((await call(D.listFolderChildren, { ...as(ALICE), query: { path: 'Secret' } })).error.status, 404);
  await call(D.deleteFolder, { ...as(ALICE), query: { path: 'Taxes/2023' } });
  assert.deepEqual((await call(D.listFolderChildren, { ...as(ALICE), query: { path: 'Taxes' } })).json.folders.map((f) => f.name), ['2024']);
});

test('every query that serves the vault is filtered to non-trashed documents', () => {
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const read = (...parts) => strip(fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8'));
  // documents.controller: every Document.find/findOne/aggregate/exists on the vault names deletedAt.
  const docs = read('controllers', 'documents.controller.js');
  for (const [, call] of docs.matchAll(/Document\.(?:find|findOne|exists|countDocuments)\(\{([^}]*)\}/g)) {
    assert.match(call, /deletedAt/, `documents.controller query without deletedAt: ${call}`);
  }
  for (const file of [['controllers', 'sync.controller.js'], ['controllers', 'backup.controller.js'], ['controllers', 'shares.controller.js']]) {
    const text = read(...file);
    for (const [, call] of text.matchAll(/Document\.(?:find|findOne|aggregate)\(\[?\{([^}]*\{[^}]*\}[^}]*|[^}]*)\}/g)) {
      assert.match(call, /deletedAt/, `${file.join('/')} query without deletedAt: ${call}`);
    }
  }
});

test('the list marks files that are in an active share link', async () => {
  reset();
  const shared = addDoc({ filename: 'shared.txt' });
  addDoc({ filename: 'private.txt' });
  world.tables.shares.push({ _id: db.oid(), shareId: 'd'.repeat(32), ownerUserId: ALICE, sourceDocumentIds: [shared._id], expiresAt: new Date(Date.now() + DAY) });
  world.tables.shares.push({ _id: db.oid(), shareId: 'e'.repeat(32), ownerUserId: BOB, sourceDocumentIds: [shared._id], expiresAt: new Date(Date.now() + DAY) });
  const list = await call(D.listDocuments, as(ALICE));
  assert.deepEqual(list.json.map((d) => [d.filename, d.shared]).sort(), [['private.txt', false], ['shared.txt', true]]);
  world.tables.shares[0].expiresAt = new Date(Date.now() - 1000);
  assert.equal((await call(D.listDocuments, as(ALICE))).json.find((d) => d.filename === 'shared.txt').shared, false, 'an expired link does not count');
});

// ---------- the storage meter and the quota ----------
const meter = async (userId = ALICE) => (await call(D.getStorage, as(userId))).json;
const expectMeter = async (label, { files, trashed, trashItems }) => {
  const m = await meter();
  assert.equal(m.fileBytes, files.reduce((n, d) => n + d.encryptedBlob.length, 0), `${label}: file bytes`);
  assert.equal(m.fileCount, files.length, `${label}: file count`);
  assert.equal(m.trashBytes, trashed.reduce((n, d) => n + d.encryptedBlob.length, 0), `${label}: trash bytes`);
  assert.equal(m.usedBytes, m.fileBytes + m.trashBytes, `${label}: used = files + trash`);
  // The meter and the Trash page agree on what is in Trash.
  const page = (await call(T.listTrash, as(ALICE))).json.items;
  assert.equal(m.trashCount, page.length, `${label}: meter trash count equals the Trash page`);
  assert.equal(page.length, trashItems, `${label}: trash items`);
  assert.equal(page.reduce((n, i) => n + i.size, 0), m.trashBytes, `${label}: the Trash page sizes add up to the meter`);
};

test('the meter equals files + Trash after every create, trash, restore, delete and purge', async () => {
  reset();
  await addFolder(ALICE, 'F');
  const a = addDoc({ filename: 'a.bin', content: Buffer.alloc(1000, 1) });
  const b = addDoc({ filename: 'b.bin', content: Buffer.alloc(2000, 2), folder: 'F' });
  const c = addDoc({ filename: 'c.bin', content: Buffer.alloc(3000, 3), folder: 'F' });
  const d = addDoc({ filename: 'd.bin', content: Buffer.alloc(4000, 4) });
  // A document from before Trash existed has no deletedAt field at all: it is live, not Trash.
  const legacy = addDoc({ filename: 'legacy.bin', content: Buffer.alloc(500, 5) });
  delete legacy.deletedAt;
  delete legacy.purgeAt;
  delete legacy.trashBatchId;
  addDoc({ filename: 'bobs.bin', userId: BOB, content: Buffer.alloc(9999) });

  await expectMeter('created', { files: [a, b, c, d, legacy], trashed: [], trashItems: 0 });
  await trash.trashDocument(ALICE, a._id);
  await expectMeter('file trashed', { files: [b, c, d, legacy], trashed: [a], trashItems: 1 });
  await call(D.deleteFolder, { ...as(ALICE), query: { path: 'F' } });
  await expectMeter('folder trashed', { files: [d, legacy], trashed: [a, b, c], trashItems: 2 });
  const [folderItem] = (await call(T.listTrash, as(ALICE))).json.items.filter((i) => i.kind === 'folder');
  await call(T.restoreItem, { ...as(ALICE), body: { kind: 'folder', id: folderItem.id } });
  await expectMeter('folder restored', { files: [b, c, d, legacy], trashed: [a], trashItems: 1 });
  await call(T.restoreItem, { ...as(ALICE), body: { kind: 'file', id: String(a._id) } });
  await expectMeter('file restored', { files: [a, b, c, d, legacy], trashed: [], trashItems: 0 });
  await trash.trashDocument(ALICE, d._id);
  await trash.trashDocument(ALICE, legacy._id);
  await expectMeter('two trashed', { files: [a, b, c], trashed: [d, legacy], trashItems: 2 });
  await call(T.deleteItem, { ...as(ALICE), params: { kind: 'file', id: String(d._id) } });
  await expectMeter('permanently deleted', { files: [a, b, c], trashed: [legacy], trashItems: 1 });
  legacy.purgeAt = new Date(Date.now() - 1000);
  await call(T.listTrash, as(ALICE)); // purge on request
  await expectMeter('purged', { files: [a, b, c], trashed: [], trashItems: 0 });
  await trash.trashDocument(ALICE, a._id);
  await call(T.emptyTrash, as(ALICE));
  await expectMeter('emptied', { files: [b, c], trashed: [], trashItems: 0 });
  assert.equal((await meter(BOB)).fileBytes, 9999, "another account's files are not counted");
});

test('no aggregation tells live from trashed with a missing-field comparison', () => {
  const root = path.join(__dirname, '..');
  for (const file of ['controllers/documents.controller.js', 'utils/storage.js', 'utils/trash.js']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(text, /\$ne:\s*\[\s*'\$deletedAt'/, `${file} compares $deletedAt inside an aggregation`);
  }
});

test('the quota refuses what would not fit, before storing it, and Trash counts until it is emptied', async () => {
  reset();
  process.env.STORAGE_QUOTA_MB = '1';
  try {
    const { assertCanStore } = require('../utils/storage');
    const big = addDoc({ filename: 'big.bin', content: Buffer.alloc(900 * 1024) });
    await assertCanStore(ALICE, 100 * 1024); // fits
    await assert.rejects(() => assertCanStore(ALICE, 200 * 1024), (err) => err.status === 413 && err.code === 'STORAGE_QUOTA' && /1 MB/.test(err.message));
    await trash.trashDocument(ALICE, big._id);
    await assert.rejects(() => assertCanStore(ALICE, 200 * 1024), (err) => err.code === 'STORAGE_QUOTA', 'Trash still counts');
    await call(T.emptyTrash, as(ALICE));
    await assertCanStore(ALICE, 200 * 1024);
    assert.equal((await meter()).quotaBytes, 1024 * 1024);
    // an upload through the real handler is refused and nothing is stored
    const full = addDoc({ filename: 'full.bin', content: Buffer.alloc(1000 * 1024) });
    const before = world.tables.documents.length;
    const res = await call(D.createDocument, { ...as(ALICE), body: {}, files: { file: [{ buffer: Buffer.alloc(100 * 1024), originalname: 'x.bin', mimetype: 'application/octet-stream' }] } });
    assert.equal(res.error.status, 413);
    assert.equal(res.error.code, 'STORAGE_QUOTA');
    assert.equal(world.tables.documents.length, before);
    assert.ok(full);
  } finally {
    delete process.env.STORAGE_QUOTA_MB;
  }
});
