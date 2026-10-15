// Run with: cd server && npm test
//
// Same-name files get a counter, and an upload sent twice stores one file. The REAL app on a LOCAL throwaway MongoDB (skipped,
// with the reason, without one); mail is captured, no .env is read.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { startLiveApp } = require('./helpers/liveApp');
const { pickFreeName, withCounter } = require('../utils/uniqueName');
const { MAX_STORED_NAME } = require('../utils/fileNames');

const PASSWORD = 'Qx7!vTr29#mLpw';
let live = { ok: false, reason: '' };

test.before(async () => {
  live = await startLiveApp('unique_names');
});
test.after(async () => {
  delete process.env.STORAGE_QUOTA_MB;
  if (live.ok) await live.stop();
});
const it = (name, fn) =>
  test(name, async (context) => {
    if (!live.ok) return context.skip(live.reason);
    const { mongoose } = live;
    delete process.env.STORAGE_QUOTA_MB;
    await mongoose.connection.dropDatabase();
    await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));
    live.mails.length = 0;
    return fn(context);
  });

const codeIn = (mail) => /(?<![\d-])(\d{6})(?![\d-])/.exec(mail.text)[1];
async function account(email) {
  const started = await live.api('POST', '/api/auth/signup/start', { json: { email, password: PASSWORD, termsAccepted: true } });
  assert.equal(started.status, 200);
  const mail = live.mails.filter((m) => m.to === email).at(-1);
  const verified = await live.api('POST', '/api/auth/signup/verify', { json: { email, password: PASSWORD, code: codeIn(mail) } });
  assert.equal(verified.status, 200);
  const user = await live.mongoose.models.User.findOne({ email }).lean();
  return { token: verified.body.sessionToken, userId: user._id, email };
}
const D = '/api/documents';
const M = () => live.mongoose.models;
function formOf(name, content = `content of ${name}`, { folder, uploadKey } = {}) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), name);
  if (folder) form.append('folder', folder);
  if (uploadKey !== undefined) form.append('uploadKey', uploadKey);
  return form;
}
const upload = (user, name, options) => live.api('POST', D, { token: user.token, form: formOf(name, options?.content, options) });
const names = async (user, folder) => (await M().Document.find({ userId: user.userId, deletedAt: null, ...(folder ? { folder } : {}) }).sort({ createdAt: 1 }).lean()).map((doc) => doc.filename);
const usedBytes = async (user) => (await live.api('GET', `${D}/storage`, { token: user.token })).body.usedBytes;

// ---------------------------------------------------------------- the helper, without a database

test('the counter: report.pdf, report (1).pdf, report (2).pdf; a free name is left alone', () => {
  assert.deepEqual(pickFreeName('report.pdf', []), { name: 'report.pdf', changed: false });
  assert.deepEqual(pickFreeName('report.pdf', ['other.pdf']), { name: 'report.pdf', changed: false });
  assert.deepEqual(pickFreeName('report.pdf', ['report.pdf']), { name: 'report (1).pdf', changed: true });
  assert.deepEqual(pickFreeName('report.pdf', ['report.pdf', 'report (1).pdf']), { name: 'report (2).pdf', changed: true });
  // a gap is filled: the FIRST free number
  assert.equal(pickFreeName('report.pdf', ['report.pdf', 'report (2).pdf']).name, 'report (1).pdf');
});

test('only the last extension is kept apart; no extension and dotfiles get the counter at the end', () => {
  assert.equal(pickFreeName('archive.tar.gz', ['archive.tar.gz']).name, 'archive.tar (1).gz');
  assert.equal(pickFreeName('README', ['README']).name, 'README (1)');
  assert.equal(pickFreeName('.env', ['.env']).name, '.env (1)');
  assert.equal(pickFreeName('notes.', ['notes.']).name, 'notes. (1)');
  assert.equal(pickFreeName('a.b.c', ['a.b.c']).name, 'a.b (1).c');
});

test('names are compared without regard to capital letters, and by Unicode composition', () => {
  assert.equal(pickFreeName('Report.PDF', ['report.pdf']).name, 'Report (1).PDF', 'the new name keeps its own spelling');
  assert.equal(pickFreeName('report.pdf', ['REPORT.pdf']).name, 'report (1).pdf');
  // "é" as one character and as "e" + a combining accent are the same name
  const composed = 'café.txt';
  const decomposed = 'café.txt';
  assert.equal(pickFreeName(decomposed, [composed]).changed, true);
  assert.equal(pickFreeName(composed, [decomposed]).changed, true);
  assert.equal(pickFreeName('履歴書.pdf', ['履歴書.pdf']).name, '履歴書 (1).pdf');
  assert.equal(pickFreeName('Über.txt', ['über.txt']).changed, true, 'a capital with a diaeresis matches its small form');
  // an emoji outside the basic plane counts as one character
  assert.equal(pickFreeName('\u{1F4C4}.txt', ['\u{1F4C4}.txt']).name, '\u{1F4C4} (1).txt');
  assert.equal(pickFreeName('  spaced.txt ', ['spaced.txt']).changed, true, 'spaces round a name do not make it different');
});

test('the whole name stays within the limit: the BASE is shortened, never the counter or the extension', () => {
  const base = 'x'.repeat(MAX_STORED_NAME - 4);
  const wanted = `${base}.pdf`;
  assert.equal([...wanted].length, MAX_STORED_NAME);
  const next = pickFreeName(wanted, [wanted]).name;
  assert.ok([...next].length <= MAX_STORED_NAME, `${[...next].length}`);
  assert.ok(next.endsWith(' (1).pdf'));
  assert.ok(next.startsWith('xxxx'));
  const many = pickFreeName(wanted, [wanted, next]).name;
  assert.ok(many.endsWith(' (2).pdf') && [...many].length <= MAX_STORED_NAME);
  // a big counter and a long Unicode name
  const long = `${'履'.repeat(MAX_STORED_NAME - 4)}.txt`;
  const taken = [long];
  const name = withCounter('履'.repeat(MAX_STORED_NAME - 4), 'txt', 12345);
  taken.push(name);
  assert.ok([...name].length <= MAX_STORED_NAME && name.endsWith(' (12345).txt'));
  assert.ok([...pickFreeName(long, taken).name].length <= MAX_STORED_NAME);
});

// ---------------------------------------------------------------- uploads

it('the second upload of a name in a folder is saved with a counter, says so, and a different folder or a Trash file does not count', async () => {
  const a = await account('names.a@example.com');
  const first = await upload(a, 'report.pdf');
  assert.equal(first.status, 201, first.text);
  assert.equal(first.body.filename, 'report.pdf');
  assert.equal(first.body.nameChanged, false);

  const second = await upload(a, 'report.pdf');
  assert.equal(second.status, 201);
  assert.equal(second.body.filename, 'report (1).pdf');
  assert.equal(second.body.nameChanged, true);
  assert.equal(second.body.requestedName, 'report.pdf');
  const third = await upload(a, 'REPORT.PDF');
  assert.equal(third.body.filename, 'REPORT (2).PDF', 'compared without regard to capitals');
  assert.deepEqual(await names(a), ['report.pdf', 'report (1).pdf', 'REPORT (2).PDF']);

  // another folder: the name is free there
  const elsewhere = await upload(a, 'report.pdf', { folder: 'Taxes' });
  assert.equal(elsewhere.body.filename, 'report.pdf');
  assert.equal(elsewhere.body.nameChanged, false);

  // a file in Trash is not in the folder: its name is free again
  await live.api('DELETE', `${D}/${first.body.id}`, { token: a.token });
  await live.api('DELETE', `${D}/${second.body.id}`, { token: a.token });
  await live.api('DELETE', `${D}/${third.body.id}`, { token: a.token });
  const fresh = await upload(a, 'report.pdf');
  assert.equal(fresh.body.filename, 'report.pdf');
  assert.equal(fresh.body.nameChanged, false);
});

it('another account\'s file of the same name does not count', async () => {
  const a = await account('names.own@example.com');
  const b = await account('names.other@example.com');
  await upload(a, 'passport.pdf');
  const mine = await upload(b, 'passport.pdf');
  assert.equal(mine.body.filename, 'passport.pdf');
  assert.equal(mine.body.nameChanged, false);
});

it('a 255-character name and a long Unicode name get a counter and stay within the limit', async () => {
  const a = await account('names.long@example.com');
  const long = `${'a'.repeat(251)}.pdf`;
  assert.equal(long.length, 255);
  await upload(a, long);
  const again = await upload(a, long);
  assert.equal(again.status, 201, again.text);
  assert.ok(again.body.filename.length <= MAX_STORED_NAME && again.body.filename.endsWith(' (1).pdf'));
  const unicode = `${'履歴書'.repeat(70)}.pdf`;
  await upload(a, unicode);
  const unicode2 = await upload(a, unicode);
  assert.ok([...unicode2.body.filename].length <= MAX_STORED_NAME && unicode2.body.filename.endsWith(' (1).pdf'));
});

it('a rename to a name already used in the folder gets a counter too (it was a silent duplicate before); the file does not clash with itself', async () => {
  const a = await account('names.rename@example.com');
  const one = await upload(a, 'one.txt');
  const two = await upload(a, 'two.txt');
  const renamed = await live.api('PATCH', `${D}/${two.body.id}`, { token: a.token, json: { filename: 'one.txt' } });
  assert.equal(renamed.status, 200, renamed.text);
  assert.equal(renamed.body.filename, 'one (1).txt');
  assert.equal(renamed.body.nameChanged, true);
  // the same name again, or only a different capital letter, on its own file: allowed as typed
  const same = await live.api('PATCH', `${D}/${one.body.id}`, { token: a.token, json: { filename: 'ONE.txt' } });
  assert.equal(same.body.filename, 'ONE.txt');
  assert.equal(same.body.nameChanged, undefined);
  assert.deepEqual(await names(a), ['ONE.txt', 'one (1).txt']);
});

it('Move and batch Move keep their rule: a taken name is a reported conflict, not a duplicate and not a rename', async () => {
  const a = await account('names.move@example.com');
  await upload(a, 'x.txt', { folder: 'Dest' });
  const loose = await upload(a, 'x.txt');
  const moved = await live.api('POST', `${D}/move`, { token: a.token, json: { items: [{ type: 'file', id: loose.body.id }], destination: 'Dest' } });
  assert.equal(moved.body.results[0].status, 'conflict');
  const batch = await live.api('POST', `${D}/batch/move`, { token: a.token, json: { ids: [loose.body.id], destination: 'Dest' } });
  assert.equal(batch.body.results[0].status, 'conflict');
  assert.deepEqual(await names(a, 'Dest'), ['x.txt']);
});

it('restoring from Trash into a taken name brings the file back with a counter (and says so)', async () => {
  const a = await account('names.restore@example.com');
  const first = await upload(a, 'plan.pdf', { folder: 'Docs' });
  await live.api('DELETE', `${D}/${first.body.id}`, { token: a.token });
  await upload(a, 'plan.pdf', { folder: 'Docs' });
  const restored = await live.api('POST', '/api/trash/restore', { token: a.token, json: { kind: 'file', id: first.body.id } });
  assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.body.name, 'plan (1).pdf');
  assert.equal(restored.body.nameChanged, true);
  assert.match(restored.body.message, /restored as "plan \(1\)\.pdf"/);
  assert.deepEqual((await names(a, 'Docs')).sort(), ['plan (1).pdf', 'plan.pdf']);
});

it('a zip import uploads every file through the same route, so imported duplicates get counters too', async () => {
  // The import (client/src/utils/zipImport.js) sends each file to POST /api/documents: the route is the one place that names files.
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'pages', 'ExportPage.jsx'), 'utf8');
  assert.match(page, /uploadFile: \(file, folder\) => uploadDocument\(\{ file, folder \}/, 'the import hands every file to the normal upload');
  const a = await account('names.import@example.com');
  await upload(a, 'scan.pdf', { folder: 'Imported' });
  for (const [index, expected] of [['', 'scan (1).pdf'], ['', 'scan (2).pdf']].map((row) => row)) {
    void index;
    const res = await upload(a, 'scan.pdf', { folder: 'Imported' });
    assert.equal(res.body.filename, expected);
  }
});

// ---------------------------------------------------------------- the upload key

const key = () => crypto.randomUUID();

it('the same upload key from the same account stores one file and charges the quota once', async () => {
  const a = await account('key.a@example.com');
  const uploadKey = key();
  const first = await upload(a, 'once.txt', { uploadKey, content: 'x'.repeat(5000) });
  assert.equal(first.status, 201);
  const charged = await usedBytes(a);
  assert.equal(charged, 5000);

  const again = await upload(a, 'once.txt', { uploadKey, content: 'x'.repeat(5000) });
  assert.equal(again.status, 200, 'the same upload again is answered, not stored');
  assert.equal(again.body.id, first.body.id, 'with the document that is already there');
  assert.equal(again.body.filename, 'once.txt', 'not "once (1).txt"');
  assert.equal(again.body.replayed, true);
  assert.deepEqual(Object.keys(first.body).filter((k) => !(k in again.body)), [], 'the same answer shape');
  assert.equal(await M().Document.countDocuments({ userId: a.userId }), 1);
  assert.equal(await usedBytes(a), charged, 'no second charge');
  assert.equal(await M().AuditEvent.countDocuments({ userId: a.userId, type: 'upload' }), 1, 'one upload event');
  assert.equal((await M().Document.findOne({ userId: a.userId }).lean()).uploadKey, uploadKey);
});

it('five requests with one key sent at the same instant produce exactly one file and one charge', async () => {
  const a = await account('key.race@example.com');
  const uploadKey = key();
  const responses = await Promise.all(Array.from({ length: 5 }, () => upload(a, 'race.txt', { uploadKey, content: 'y'.repeat(3000) })));
  assert.ok(responses.every((res) => res.status === 201 || res.status === 200), responses.map((res) => res.status).join(','));
  assert.equal(new Set(responses.map((res) => res.body.id)).size, 1, 'every answer names the same document');
  assert.equal(responses.filter((res) => res.status === 201).length, 1, 'only one was stored');
  assert.equal(await M().Document.countDocuments({ userId: a.userId }), 1);
  assert.equal(await usedBytes(a), 3000);
  assert.equal(await M().AuditEvent.countDocuments({ userId: a.userId, type: 'upload' }), 1);
});

it('the key belongs to one account: another user with the same key is a separate upload', async () => {
  const a = await account('key.own@example.com');
  const b = await account('key.other@example.com');
  const uploadKey = key();
  const mine = await upload(a, 'shared-key.txt', { uploadKey });
  const theirs = await upload(b, 'shared-key.txt', { uploadKey });
  assert.equal(theirs.status, 201, 'not treated as A\'s upload');
  assert.notEqual(theirs.body.id, mine.body.id);
  assert.equal(await M().Document.countDocuments({}), 2);
  // and B can never read A's document through the key
  const replay = await upload(b, 'shared-key.txt', { uploadKey });
  assert.equal(replay.body.id, theirs.body.id);
  assert.notEqual(replay.body.id, mine.body.id);
});

it('a key must be a UUID; none is fine; a different key is a different upload (and gets a counter for the same name)', async () => {
  const a = await account('key.valid@example.com');
  for (const bad of ['', 'not-a-uuid', '12345', `${key()}x`, '../../etc', key().toUpperCase().slice(1), 'a'.repeat(200)]) {
    const res = await upload(a, 'bad.txt', { uploadKey: bad });
    assert.equal(res.status, 400, `${JSON.stringify(bad)} -> ${res.status}`);
  }
  assert.equal(await M().Document.countDocuments({}), 0, 'a bad key stores nothing');
  assert.equal((await upload(a, 'keyless.txt')).status, 201);
  assert.equal((await upload(a, 'keyless.txt')).body.filename, 'keyless (1).txt', 'without a key, two uploads are two files');
  const k1 = await upload(a, 'k.txt', { uploadKey: key() });
  const k2 = await upload(a, 'k.txt', { uploadKey: key() });
  assert.equal(k2.status, 201);
  assert.equal(k2.body.filename, 'k (1).txt');
  assert.notEqual(k1.body.id, k2.body.id);
  // an object smuggled in as the key (bracket syntax) is not a UUID
  const form = formOf('obj.txt');
  form.append('uploadKey[$ne]', 'x');
  assert.equal((await live.api('POST', D, { token: a.token, form })).status, 400);
});

it('a replay is answered even if the first upload was trashed meanwhile, and a replay over the quota is not refused (nothing is stored)', async () => {
  const a = await account('key.trash@example.com');
  const uploadKey = key();
  const first = await upload(a, 'gone.txt', { uploadKey, content: 'z'.repeat(2000) });
  await live.api('DELETE', `${D}/${first.body.id}`, { token: a.token });
  const replay = await upload(a, 'gone.txt', { uploadKey, content: 'z'.repeat(2000) });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, first.body.id);
  assert.equal(await M().Document.countDocuments({ userId: a.userId }), 1);
  process.env.STORAGE_QUOTA_MB = String(1 / 1024); // 1 KB: everything new is too big
  assert.equal((await upload(a, 'gone.txt', { uploadKey, content: 'z'.repeat(2000) })).status, 200);
  assert.equal((await upload(a, 'new.txt', { uploadKey: key(), content: 'z'.repeat(2000) })).status, 413, 'the quota still refuses a new upload');
});

it('the upload-key index is partial and unique on { userId, uploadKey }, and the migration cannot fail on existing duplicate names', async () => {
  const indexes = await M().Document.collection.indexes();
  const index = indexes.find((entry) => entry.key.userId === 1 && entry.key.uploadKey === 1);
  assert.ok(index, 'built by the migration');
  assert.equal(index.unique, true);
  assert.deepEqual(index.partialFilterExpression, { uploadKey: { $type: 'string' } });
  assert.ok(!indexes.some((entry) => Object.keys(entry.key).includes('filename') && entry.unique), 'no unique index on names');

  // old data: two documents with the same name and no key, and several with no key at all: the index builds regardless
  const a = await account('key.migrate@example.com');
  const base = { userId: a.userId, filename: 'same.txt', folder: 'root', encryptedBlob: Buffer.from('x'), iv: 'a', authTag: 'b', checksum: 'c', mimeType: 'text/plain', originDevice: 'pc' };
  await M().Document.collection.insertMany([{ ...base }, { ...base }, { ...base, filename: 'other.txt' }]);
  await M().Document.collection.dropIndex(index.name);
  const { migrateIndexes } = require('../utils/migrateIndexes');
  await M().Document.collection.createIndex({ userId: 1, uploadKey: 1 }, { unique: true, partialFilterExpression: { uploadKey: { $type: 'string' } } });
  assert.equal(typeof migrateIndexes, 'function');
  assert.equal(await M().Document.countDocuments({ userId: a.userId }), 3);
});

it('an emergency session cannot upload (the route is not on the allowlist)', async () => {
  const { createSession } = require('../utils/sessionStore');
  const a = await account('key.emergency@example.com');
  const token = await createSession(a.userId, crypto.randomBytes(32), {
    emergency: { accessId: new live.mongoose.Types.ObjectId(), requestId: new live.mongoose.Types.ObjectId(), scopeMode: 'all', absoluteMs: 4 * 3600 * 1000 },
  });
  const res = await live.api('POST', D, { token, form: formOf('nope.txt', 'x', { uploadKey: key() }) });
  assert.equal(res.status, 403);
  assert.equal(await M().Document.countDocuments({}), 0);
});
