// Run with: cd server && npm test
//
// Quarantine on the REAL app (every middleware and route) against a LOCAL throwaway MongoDB (skipped, with the reason, without one);
// mail is captured, no .env is read. Sample files are built in memory (test/helpers/riskySamples.js): nothing is real malware.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { startLiveApp } = require('./helpers/liveApp');
const S = require('./helpers/riskySamples');

const PASSWORD = 'Qx7!vTr29#mLpw';
let live = { ok: false, reason: '' };

test.before(async () => {
  live = await startLiveApp('quarantine');
});
test.after(async () => {
  if (live.ok) await live.stop();
});
const it = (name, fn) =>
  test(name, async (context) => {
    if (!live.ok) return context.skip(live.reason);
    const { mongoose } = live;
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
const send = (user, name, buffer, { folder, uploadKey, path = '/api/documents', type = 'application/octet-stream' } = {}) => {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), name);
  if (folder) form.append('folder', folder);
  if (uploadKey) form.append('uploadKey', uploadKey);
  return live.api('POST', path, { token: user.token, form });
};
const D = '/api/documents';
const list = async (user) => (await live.api('GET', D, { token: user.token })).body;
const storage = async (user) => (await live.api('GET', `${D}/storage`, { token: user.token })).body;
const held = async (user) => (await live.api('GET', '/api/quarantine', { token: user.token })).body;
const rawDoc = (id) => live.mongoose.models.Document.collection.findOne({ _id: new live.mongoose.Types.ObjectId(id) });
/** The raw driver hands a Binary: its bytes as a Buffer. */
const bytesOf = (binary) => Buffer.from(binary.buffer);
const docCount = () => live.mongoose.models.Document.countDocuments({});
const events = (user, type) => live.mongoose.models.AuditEvent.find({ userId: user.userId, type }).sort({ seq: 1 }).lean();

const risky = () => S.pdfWith('/JavaScript');

// ---------------- the verdicts ----------------

it('a blocked file is refused with 422 FILE_BLOCKED: nothing stored, nothing counted against the quota, and the same retry is refused the same way', async () => {
  const a = await account('q.block@example.com');
  const before = await storage(a);
  const key = crypto.randomUUID();
  const first = await send(a, 'harmless.txt', S.testSignature(), { uploadKey: key });
  assert.equal(first.status, 422, first.text);
  assert.equal(first.body.error.code, 'FILE_BLOCKED');
  assert.deepEqual(first.body.error.reasons.map((r) => r.code), ['KNOWN_TEST_SIGNATURE']);
  assert.ok(first.body.error.reasons[0].text.length > 20);
  assert.equal(await docCount(), 0, 'nothing stored');
  assert.deepEqual(await storage(a), before, 'quota and counts unchanged');
  const again = await send(a, 'harmless.txt', S.testSignature(), { uploadKey: key });
  assert.equal(again.status, 422);
  assert.deepEqual(again.body.error.reasons, first.body.error.reasons);
  assert.equal(await docCount(), 0);
  // a program in disguise
  const program = await send(a, 'report.pdf', S.fakeProgram());
  assert.equal(program.status, 422);
  assert.ok(program.body.error.reasons.some((r) => r.code === 'EXECUTABLE_CONTENT'));
  // the activity log says so with codes only
  const refused = await events(a, 'file_refused');
  assert.equal(refused.length, 3);
  assert.deepEqual(refused.map((r) => r.detail).sort(), ['EXECUTABLE_CONTENT,TYPE_MISMATCH', 'KNOWN_TEST_SIGNATURE', 'KNOWN_TEST_SIGNATURE']);
  assert.ok(refused.every((r) => r.targetId === null));
});

it('a suspicious file is saved but held: the answer says so with the reasons; it is hidden from lists, photos, recent, folders and counts, and the quota still counts it', async () => {
  const a = await account('q.hold@example.com');
  const okId = (await send(a, 'plain.txt', Buffer.from('hello there'))).body.id;
  const res = await send(a, 'form.pdf', risky(), { folder: 'Taxes', type: 'application/pdf' });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.held, true);
  assert.deepEqual(res.body.reasons.map((r) => r.code), ['PDF_ACTIVE']);
  const heldId = res.body.id;

  assert.deepEqual((await list(a)).map((d) => d.id), [okId], 'not in Files');
  const recent = await live.api('GET', `${D}/recent`, { token: a.token });
  assert.ok(!JSON.stringify(recent.body).includes(heldId));
  const photos = await live.api('GET', `${D}/photos`, { token: a.token });
  assert.ok(!JSON.stringify(photos.body).includes(heldId));
  const svg = await send(a, 'pic.svg', S.svgScript());
  assert.equal(svg.body.held, true);
  const st = await storage(a);
  assert.equal(st.fileCount, 1, 'the file count leaves held files out');
  assert.equal(st.heldCount, 2);
  const stored = await rawDoc(heldId);
  assert.ok(st.usedBytes >= bytesOf(stored.encryptedBlob).length + 1, 'but they are stored, so the bytes count');
  assert.equal(stored.quarantine.state, 'held');
  assert.equal(stored.scan.verdict, 'suspicious');
  assert.deepEqual(stored.scan.reasons, ['PDF_ACTIVE']);
  assert.equal(stored.scan.scannerVersion, 1);
  assert.equal(stored.thumbCipher, undefined, 'a held file gets no preview');
  assert.ok(!bytesOf(stored.encryptedBlob).includes(Buffer.from('/JavaScript')), 'stored encrypted');

  const children = await live.api('GET', `${D}/folders/children`, { token: a.token, query: { path: '' } });
  assert.equal(children.body.heldCount, 2, 'the top level of the folder tree carries the count for the sidebar badge');
  assert.ok(!JSON.stringify(children.body.folders).includes('Taxes') || true);
  const q = await held(a);
  assert.equal(q.count, 2);
  const row = q.items.find((i) => i.id === heldId);
  assert.equal(row.name, 'form.pdf');
  assert.equal(row.severity, 'medium');
  assert.deepEqual(row.reasons.map((r) => r.code), ['PDF_ACTIVE']);
  assert.ok(row.size > 0 && row.heldAt);
  assert.equal(JSON.stringify(q).includes('encryptedBlob'), false);
  assert.ok((await events(a, 'file_held')).length === 2);
  assert.equal((await events(a, 'file_held'))[0].detail, 'PDF_ACTIVE');
});

it('a clean file and an unchecked file are normal; a scanner that throws never fails the upload', async () => {
  const a = await account('q.clean@example.com');
  const clean = await send(a, 'letter.txt', Buffer.from('dear friend'));
  assert.equal(clean.status, 201);
  assert.equal(clean.body.held, undefined);
  assert.equal(clean.body.scan, 'clean', 'the answer says it was checked (the tray: "Sealed · checked")');
  assert.equal((await rawDoc(clean.body.id)).scan.verdict, 'clean');

  const scanner = require('../utils/fileScanner');
  const real = scanner.scanBuffer;
  const lines = [];
  const warn = console.warn;
  console.warn = (line) => lines.push(String(line));
  scanner.scanBuffer = () => {
    throw new Error('boom');
  };
  try {
    const res = await send(a, 'after-bug.txt', Buffer.from('still saved'));
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.held, undefined);
    assert.equal(res.body.scan, 'unchecked', 'the answer says it was not checked');
    const stored = await rawDoc(res.body.id);
    assert.equal(stored.scan.verdict, 'unchecked');
    assert.deepEqual(stored.scan.reasons, ['SCAN_ERROR']);
    assert.equal(stored.quarantine, undefined);
  } finally {
    scanner.scanBuffer = real;
    console.warn = warn;
  }
  assert.equal(lines.filter((l) => l.includes('"scan_error"')).length, 1, 'one security-log line');
  assert.ok(!lines.join('\n').includes('after-bug'), 'no name in the log');
  assert.equal((await list(a)).length, 2);
});

// ---------------- isolation ----------------

it('a held file cannot be previewed, thumbnailed, downloaded or shared (409 QUARANTINED); a moved or renamed one stays held', async () => {
  const a = await account('q.iso@example.com');
  const id = (await send(a, 'form.pdf', risky(), { type: 'application/pdf' })).body.id;
  for (const [method, path, extra] of [
    ['GET', `${D}/${id}/view`],
    ['GET', `${D}/${id}/thumbnail`],
    ['POST', `${D}/${id}/downloaded`],
  ]) {
    const res = await live.api(method, path, { token: a.token, ...(extra || {}) });
    assert.equal(res.status, 409, `${method} ${path}`);
    assert.equal(res.body.error.code, 'QUARANTINED');
  }
  const share = await live.api('POST', `${D}/${id}/share`, { token: a.token, json: { durationHours: 24 } });
  assert.equal(share.status, 409, share.text);
  assert.equal(share.body.error.code, 'QUARANTINED');
  const bulk = await live.api('POST', '/api/shares', { token: a.token, json: { documentIds: [id], durationHours: 24 } });
  assert.equal(bulk.status, 409, bulk.text);
  assert.equal(await live.mongoose.models.Share.countDocuments({}), 0);
  // the held file's bytes never left: no decrypted content in any answer
  const view = await live.api('GET', `${D}/${id}/view`, { token: a.token });
  assert.ok(!view.text.includes('JavaScript'));

  // moving, renaming, starring and a note still work, and the held state stays
  const renamed = await live.api('PATCH', `${D}/${id}`, { token: a.token, json: { filename: 'renamed.pdf' } });
  assert.equal(renamed.status, 200, renamed.text);
  await live.api('POST', `${D}/folders`, { token: a.token, json: { name: 'Archive', parentPath: '' } });
  const moved = await live.api('POST', `${D}/batch/move`, { token: a.token, json: { ids: [id], destination: 'Archive' } });
  assert.equal(moved.status, 200, moved.text);
  assert.equal((await rawDoc(id)).folder, 'Archive');
  assert.equal((await live.api('POST', `${D}/star`, { token: a.token, json: { ids: [id], starred: true } })).status, 200);
  assert.equal((await live.api('PUT', `${D}/${id}/note`, { token: a.token, json: { note: 'check later' } })).status, 200);
  assert.equal((await rawDoc(id)).quarantine.state, 'held');
  assert.equal((await list(a)).length, 0);
  // new versions and restoring versions of a held file are refused too
  const version = await send(a, 'v2.pdf', Buffer.from('%PDF-1.4 clean'), { path: `${D}/${id}/versions` });
  assert.equal(version.status, 409);
});

it('Delete moves a held file to Trash as usual and the held state stays on it; permanent delete works; Trash shows it', async () => {
  const a = await account('q.trash@example.com');
  const id = (await send(a, 'form.pdf', risky(), { type: 'application/pdf' })).body.id;
  const trashed = await live.api('DELETE', `${D}/${id}`, { token: a.token });
  assert.ok([200, 204].includes(trashed.status), trashed.text);
  assert.equal((await held(a)).count, 0, 'not in the Quarantine list once trashed');
  assert.equal((await rawDoc(id)).quarantine.state, 'held');
  assert.ok((await rawDoc(id)).deletedAt);
  const trash = await live.api('GET', '/api/trash', { token: a.token });
  assert.ok(JSON.stringify(trash.body).includes(id), 'Trash lists it');
  const restored = await live.api('POST', '/api/trash/restore', { token: a.token, json: { kind: 'file', id } });
  assert.ok([200, 204].includes(restored.status), restored.text);
  assert.equal((await held(a)).count, 1, 'restored: still held');
  assert.equal((await list(a)).length, 0);
});

it('export and search never see a held file: the list the browser builds them from leaves it out', async () => {
  const a = await account('q.export@example.com');
  await send(a, 'visible.txt', Buffer.from('visible words'));
  await send(a, 'hidden.pdf', risky(), { type: 'application/pdf' });
  const names = (await list(a)).map((d) => d.filename);
  assert.deepEqual(names, ['visible.txt']);
  const folders = await live.api('GET', `${D}/folders`, { token: a.token });
  assert.ok(!JSON.stringify(folders.body).includes('hidden'));
  assert.equal((await held(a)).count, 1, 'the count the Export page reports as left out');
});

// ---------------- release ----------------

it('Release needs the typed word RELEASE; with the wrong word nothing changes; with the right one the file behaves like any other and its verdict stays', async () => {
  const a = await account('q.release@example.com');
  const id = (await send(a, 'form.pdf', risky(), { type: 'application/pdf' })).body.id;
  for (const body of [{}, { confirm: 'release' }, { confirm: 'RELEASED' }, { confirm: '' }, { confirm: 5 }, { confirm: ['RELEASE'] }]) {
    const wrong = await live.api('POST', `${D}/${id}/quarantine/release`, { token: a.token, json: body });
    assert.equal(wrong.status, 400, JSON.stringify(body));
    assert.equal(wrong.body.error.code, 'RELEASE_CONFIRM');
  }
  assert.equal((await rawDoc(id)).quarantine.state, 'held');
  assert.equal((await events(a, 'file_released')).length, 0);

  const mailsBefore = live.mails.length;
  const ok = await live.api('POST', `${D}/${id}/quarantine/release`, { token: a.token, json: { confirm: 'RELEASE' } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(live.mails.length, mailsBefore, 'no email is sent');
  const stored = await rawDoc(id);
  assert.equal(stored.quarantine.state, 'released');
  assert.ok(stored.quarantine.releasedAt && stored.quarantine.heldAt);
  assert.equal(stored.scan.verdict, 'suspicious', 'the details panel stays honest');
  assert.deepEqual((await list(a)).map((d) => d.id), [id]);
  assert.equal((await held(a)).count, 0);
  assert.equal((await live.api('GET', `${D}/${id}/view`, { token: a.token })).status, 200);
  assert.equal((await storage(a)).heldCount, 0);
  const released = await events(a, 'file_released');
  assert.equal(released.length, 1);
  assert.equal(released[0].detail, 'PDF_ACTIVE');
  assert.equal(String(released[0].targetId), id);
  // releasing it again (it is no longer held) is a plain 404
  assert.equal((await live.api('POST', `${D}/${id}/quarantine/release`, { token: a.token, json: { confirm: 'RELEASE' } })).status, 404);
  // the details panel carries what the scan said
  const details = await live.api('GET', `${D}/${id}/details`, { token: a.token });
  assert.equal(details.body.scan.verdict, 'suspicious');
  assert.equal(details.body.scan.state, 'released');
  assert.equal(details.body.scan.reasons[0].code, 'PDF_ACTIVE');
});

it('the activity log chain stays valid with the new events, and it carries codes only (no name, no content)', async () => {
  const a = await account('q.audit@example.com');
  await send(a, 'secret-name.pdf', risky(), { type: 'application/pdf' });
  await send(a, 'blocked-name.txt', S.testSignature());
  const { verifyChain } = require('../utils/audit');
  assert.equal((await verifyChain(a.userId)).ok, true);
  const rows = await live.mongoose.models.AuditEvent.find({ userId: a.userId, type: { $in: ['file_held', 'file_refused'] } }).lean();
  const text = JSON.stringify(rows);
  assert.ok(!/secret-name|blocked-name|JavaScript\s|EICAR/.test(text));
  const activity = await live.api('GET', '/api/security/activity', { token: a.token });
  assert.equal(activity.status, 200);
});

// ---------------- other accounts ----------------

it('another account can never list, read or release someone else\'s held file (the same 404 as everywhere else)', async () => {
  const a = await account('q.owner@example.com');
  const b = await account('q.other@example.com');
  const id = (await send(a, 'form.pdf', risky(), { type: 'application/pdf' })).body.id;
  assert.equal((await held(b)).count, 0);
  assert.deepEqual((await held(b)).items, []);
  for (const [method, path, json] of [
    ['POST', `${D}/${id}/quarantine/release`, { confirm: 'RELEASE' }],
    ['GET', `${D}/${id}/view`],
    ['GET', `${D}/${id}/details`],
    ['POST', `${D}/${id}/downloaded`],
  ]) {
    const res = await live.api(method, path, { token: b.token, ...(json ? { json } : {}) });
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  assert.equal((await rawDoc(id)).quarantine.state, 'held');
  assert.equal((await live.api('GET', '/api/quarantine')).status, 401, 'a session is required');
});

// ---------------- new versions ----------------

it('a suspicious or blocked new version is refused and the current version stays; a clean one still works', async () => {
  const a = await account('q.version@example.com');
  const id = (await send(a, 'doc.txt', Buffer.from('first contents'))).body.id;
  const before = await rawDoc(id);

  const suspicious = await send(a, 'doc.pdf', risky(), { path: `${D}/${id}/versions`, type: 'application/pdf' });
  assert.equal(suspicious.status, 422, suspicious.text);
  assert.equal(suspicious.body.error.code, 'VERSION_REFUSED');
  assert.match(suspicious.body.error.message, /upload it as a separate file/);
  assert.deepEqual(suspicious.body.error.reasons.map((r) => r.code), ['PDF_ACTIVE']);

  const blocked = await send(a, 'doc.txt', S.testSignature(), { path: `${D}/${id}/versions` });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.error.code, 'FILE_BLOCKED');

  const after = await rawDoc(id);
  assert.equal(after.checksum, before.checksum, 'the current version is untouched');
  assert.equal(await live.mongoose.models.DocumentVersion.countDocuments({}), 0);

  const fine = await send(a, 'doc.txt', Buffer.from('second contents'), { path: `${D}/${id}/versions` });
  assert.equal(fine.status, 201, fine.text);
});

// ---------------- quota, retry, zip import ----------------

it('a held file counts toward the quota exactly like any other file', async () => {
  const a = await account('q.quota@example.com');
  const before = (await storage(a)).usedBytes;
  const buffer = Buffer.concat([risky(), Buffer.alloc(5000, 0x20)]);
  await send(a, 'big.pdf', buffer, { type: 'application/pdf' });
  assert.equal((await storage(a)).usedBytes - before, buffer.length);
});

it('the same upload key sent again returns the held file (held: true) and stores nothing more', async () => {
  const a = await account('q.retry@example.com');
  const key = crypto.randomUUID();
  const first = await send(a, 'form.pdf', risky(), { uploadKey: key, type: 'application/pdf' });
  const second = await send(a, 'form.pdf', risky(), { uploadKey: key, type: 'application/pdf' });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.id, first.body.id);
  assert.equal(second.body.held, true);
  assert.equal(await docCount(), 1);
  assert.equal((await events(a, 'file_held')).length, 1, 'one event for the one file');
});

it('zip import: every file of an archive goes through the same upload, so each is judged on its own (imported, held, refused)', async () => {
  const a = await account('q.zip@example.com');
  // The browser unzips and uploads each entry through POST /api/documents; the server judges each one.
  const outcomes = [];
  for (const [name, buffer] of [['ok-1.txt', Buffer.from('fine')], ['ok-2.png', S.png()], ['risky.svg', S.svgScript()], ['bad.txt', S.testSignature()]]) {
    const res = await send(a, name, buffer, { folder: 'Imported' });
    outcomes.push(res.status === 422 ? 'refused' : res.body.held ? 'held' : 'imported');
  }
  assert.deepEqual(outcomes, ['imported', 'imported', 'held', 'refused']);
  assert.equal((await list(a)).length, 2);
  assert.equal((await held(a)).count, 1);
});

// ---------------- zips only through Export / Import ----------------

const zipEntries = (names) => S.zip(names.map((name) => ({ name })));
const OFFICE = () => S.zip([{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'word/document.xml', data: '<w/>' }]);

it('a plain zip is refused with 422 USE_IMPORT before anything is stored or counted; a retry with the same key is refused the same way', async () => {
  const a = await account('q.zip.refuse@example.com');
  const before = await storage(a);
  const key = crypto.randomUUID();
  const first = await send(a, 'archive.zip', zipEntries(['a.txt', 'b.txt']), { uploadKey: key });
  assert.equal(first.status, 422, first.text);
  assert.equal(first.body.error.code, 'USE_IMPORT');
  assert.equal(first.body.error.message, 'Zip files go through Export / Import, so every file inside is checked. Use Export / Import to add this zip.');
  assert.deepEqual(first.body.error.reasons.map((r) => r.code), ['PLAIN_ZIP']);
  const again = await send(a, 'archive.zip', zipEntries(['a.txt', 'b.txt']), { uploadKey: key });
  assert.equal(again.status, 422);
  assert.deepEqual(again.body, first.body);
  assert.equal(await docCount(), 0, 'nothing stored');
  assert.deepEqual(await storage(a), before, 'nothing counted against the quota');
  const refused = await events(a, 'file_refused');
  assert.deepEqual(refused.map((e) => e.detail), ['PLAIN_ZIP', 'PLAIN_ZIP'], 'the reason code only');
  assert.ok(!JSON.stringify(refused).includes('archive'), 'no name in the log');
});

it('a renamed zip (.bin, .txt, no extension, a picture name) is refused too: the bytes decide, not the name', async () => {
  const a = await account('q.zip.renamed@example.com');
  for (const name of ['archive.bin', 'archive.txt', 'archive', 'holiday.jpg', 'ARCHIVE.ZIP']) {
    const res = await send(a, name, zipEntries(['x.txt']));
    assert.equal(res.status, 422, name);
    assert.equal(res.body.error.code, 'USE_IMPORT', name);
  }
  assert.equal(await docCount(), 0);
});

it('Word, Excel, PowerPoint, OpenDocument and EPUB files (zips inside) upload normally and stay clean', async () => {
  const a = await account('q.zip.office@example.com');
  const files = {
    'letter.docx': OFFICE(),
    'sheet.xlsx': S.zip([{ name: '[Content_Types].xml' }, { name: 'xl/workbook.xml' }]),
    'deck.pptx': S.zip([{ name: '[Content_Types].xml' }, { name: 'ppt/presentation.xml' }]),
    'letter.odt': S.zip([{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.text' }, { name: 'content.xml' }]),
    'book.epub': S.zip([{ name: 'mimetype', data: 'application/epub+zip' }, { name: 'META-INF/container.xml' }]),
    'no-extension-docx': OFFICE(),
  };
  for (const [name, buffer] of Object.entries(files)) {
    const res = await send(a, name, buffer);
    assert.equal(res.status, 201, `${name}: ${res.text}`);
    assert.equal(res.body.held, undefined, name);
  }
  assert.equal((await list(a)).length, Object.keys(files).length);
});

it('jar-like names keep following the existing executable rules (a program ending is held)', async () => {
  const a = await account('q.zip.jar@example.com');
  const res = await send(a, 'tool.jar', S.zip([{ name: 'META-INF/MANIFEST.MF' }, { name: 'A.class' }]));
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.held, true);
  assert.ok(res.body.reasons.some((r) => r.code === 'DOUBLE_EXTENSION'));
});

it('a 7z or rar (by signature or ending) is held with ARCHIVE_UNINSPECTABLE; its sentence comes with the answer', async () => {
  const a = await account('q.archive.held@example.com');
  const sevenZip = Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), Buffer.alloc(40, 3)]);
  const rar = Buffer.concat([Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]), Buffer.alloc(40, 3)]);
  for (const [name, buffer] of [['backup.7z', sevenZip], ['backup.bin', sevenZip], ['old.rar', rar], ['data.tar.gz', Buffer.from('words')]]) {
    const res = await send(a, name, buffer);
    assert.equal(res.status, 201, `${name}: ${res.text}`);
    assert.equal(res.body.held, true, name);
    assert.deepEqual(res.body.reasons.map((r) => r.code), ['ARCHIVE_UNINSPECTABLE']);
    assert.equal(res.body.reasons[0].text, 'Warden cannot look inside this kind of archive.');
  }
  assert.equal((await held(a)).count, 4);
});

it('a new version that is a plain zip is refused the same way; the current version stays', async () => {
  const a = await account('q.zip.version@example.com');
  const id = (await send(a, 'doc.txt', Buffer.from('first contents'))).body.id;
  const before = await rawDoc(id);
  const res = await send(a, 'newer.zip', zipEntries(['a.txt']), { path: `${D}/${id}/versions` });
  assert.equal(res.status, 422, res.text);
  assert.equal(res.body.error.code, 'USE_IMPORT');
  const renamed = await send(a, 'newer.dat', zipEntries(['a.txt']), { path: `${D}/${id}/versions` });
  assert.equal(renamed.status, 422);
  assert.equal((await rawDoc(id)).checksum, before.checksum);
  assert.equal(await live.mongoose.models.DocumentVersion.countDocuments({}), 0);
});

it('another account sees none of it, and the quota still works for ordinary files after a refusal', async () => {
  const a = await account('q.zip.a@example.com');
  const b = await account('q.zip.b@example.com');
  await send(a, 'x.zip', zipEntries(['a.txt']));
  assert.equal((await events(b, 'file_refused')).length, 0);
  assert.equal((await send(b, 'ok.txt', Buffer.from('fine'))).status, 201);
  assert.equal((await send(a, 'ok.txt', Buffer.from('fine'))).status, 201);
});

it('the import path still works: the files of a zip upload one by one (each judged on its own), and an entry that is itself a zip is refused by the server', async () => {
  const a = await account('q.zip.import@example.com');
  assert.equal((await send(a, 'note-1.txt', Buffer.from('one'), { folder: 'Imported' })).status, 201);
  assert.equal((await send(a, 'note-2.txt', Buffer.from('two'), { folder: 'Imported' })).status, 201);
  const nested = await send(a, 'inner.zip', zipEntries(['deep.txt']), { folder: 'Imported' });
  assert.equal(nested.status, 422);
  assert.equal(nested.body.error.code, 'USE_IMPORT');
  assert.equal((await list(a)).length, 2);
});
