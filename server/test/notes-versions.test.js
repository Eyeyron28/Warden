const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { startLiveApp } = require('./helpers/liveApp');

const PASSWORD = 'Qx7!vTr29#mLpw';
let live = { ok: false, reason: '' };

test.before(async () => {
  live = await startLiveApp('notes_versions');
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
const formOf = (name, content, type = 'text/plain') => {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), name);
  return form;
};
async function upload(user, name, content, folder) {
  const form = formOf(name, content ?? `content of ${name} `.repeat(5));
  if (folder) form.append('folder', folder);
  const res = await live.api('POST', '/api/documents', { token: user.token, form });
  assert.equal(res.status, 201, res.text);
  return res.body.id;
}
const D = '/api/documents';
const M = () => live.mongoose.models;
const oid = (id) => new live.mongoose.Types.ObjectId(String(id));
const rawDoc = (id) => M().Document.collection.findOne({ _id: oid(id) });
const details = async (user, id) => (await live.api('GET', `${D}/${id}/details`, { token: user.token })).body;
const newVersion = (user, id, content, type) => live.api('POST', `${D}/${id}/versions`, { token: user.token, form: formOf('whatever-name.txt', content, type) });
const view = (user, id) => live.api('GET', `${D}/${id}/view`, { token: user.token, query: { for: 'silent' } });
const setNote = (user, id, note) => live.api('PUT', `${D}/${id}/note`, { token: user.token, json: { note } });
const orphanVersions = async () => {
  const ids = await M().DocumentVersion.distinct('documentId');
  const alive = new Set((await M().Document.distinct('_id', { _id: { $in: ids } })).map(String));
  return ids.filter((id) => !alive.has(String(id)));
};

it('a note is stored encrypted, comes back only in the details, and the list says only that there is one', async () => {
  const a = await account('note.a@example.com');
  const id = await upload(a, 'passport.txt');
  const text = 'Locker 14, code 7391 — ask Maria\nsecond line';
  const put = await setNote(a, id, text);
  assert.equal(put.status, 200, put.text);
  assert.deepEqual(put.body, { id, hasNote: true, note: text });

  const row = await rawDoc(id);
  assert.equal(row.hasNote, true);
  assert.ok(row.noteCipher && row.noteIv && row.noteAuthTag, 'stored as cipher + iv + auth tag, like a share label');
  const wholeRow = JSON.stringify(row);
  for (const piece of ['Locker', '7391', 'Maria']) assert.ok(!wholeRow.includes(piece), `${piece} is not in the stored row`);

  assert.equal((await details(a, id)).note, text);
  assert.equal((await details(a, id)).hasNote, true);
  const listed = (await live.api('GET', D, { token: a.token })).body.find((doc) => doc.id === id);
  assert.equal(listed.hasNote, true);
  assert.ok(!('note' in listed) && !JSON.stringify(listed).includes('7391'));
  const kids = await live.api('GET', `${D}/folders/children`, { token: a.token, query: { path: '' } });
  assert.ok(!kids.text.includes('7391'));
  const recent = await live.api('GET', `${D}/recent`, { token: a.token });
  assert.ok(!recent.text.includes('7391'));
  const other = await upload(a, 'plain.txt');
  assert.equal((await details(a, other)).note, null);
  assert.equal((await live.api('GET', D, { token: a.token })).body.find((doc) => doc.id === other).hasNote, false);
});

it('a note is plain text up to 2000 characters; anything else is rejected and changes nothing', async () => {
  const a = await account('note.limits@example.com');
  const id = await upload(a, 'n.txt');
  assert.equal((await setNote(a, id, 'x'.repeat(2000))).status, 200, '2000 is allowed');
  assert.equal((await setNote(a, id, 'x'.repeat(2001))).status, 400, '2001 is not');
  for (const bad of [123, ['a'], { a: 1 }, true, 'bell\u0007char', 'nul\u0000byte']) {
    const res = await setNote(a, id, bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  assert.equal((await live.api('PUT', `${D}/${id}/note`, { token: a.token, json: {} })).status, 400, 'note is required');
  assert.equal((await live.api('PUT', `${D}/not-an-id/note`, { token: a.token, json: { note: 'x' } })).status, 404);
  assert.equal((await details(a, id)).note, 'x'.repeat(2000), 'the rejected ones changed nothing');
  const html = '<img src=x onerror=alert(1)> **not bold**';
  assert.equal((await setNote(a, id, html)).body.note, html);
  assert.equal((await details(a, id)).note, html);
});

it('clearing removes every stored piece of the note; whitespace only counts as clearing', async () => {
  const a = await account('note.clear@example.com');
  const id = await upload(a, 'n.txt');
  await setNote(a, id, 'something');
  assert.deepEqual((await setNote(a, id, null)).body, { id, hasNote: false, note: null });
  let row = await rawDoc(id);
  assert.equal(row.hasNote, false);
  assert.ok(!('noteCipher' in row) && !('noteIv' in row) && !('noteAuthTag' in row));
  await setNote(a, id, 'again');
  assert.equal((await setNote(a, id, '   \n ')).body.hasNote, false);
  row = await rawDoc(id);
  assert.ok(!('noteCipher' in row));
});

it('the activity log records only that a note was set, changed or cleared - never its text - and a note is not a file change', async () => {
  const a = await account('note.audit@example.com');
  const id = await upload(a, 'n.txt');
  const before = (await rawDoc(id)).updatedAt.getTime();
  await setNote(a, id, 'first secret words');
  await setNote(a, id, 'first secret words');
  await setNote(a, id, 'second secret words');
  await setNote(a, id, null);
  await setNote(a, id, null);
  const events = await M().AuditEvent.find({ userId: a.userId, type: /^note_/ }).sort({ seq: 1 }).lean();
  assert.deepEqual(events.map((event) => event.type), ['note_set', 'note_changed', 'note_cleared']);
  assert.ok(events.every((event) => event.targetId === id));
  const everything = JSON.stringify(await M().AuditEvent.find({ userId: a.userId }).lean());
  assert.ok(!everything.includes('secret words'), 'no text in the log');
  assert.equal((await rawDoc(id)).updatedAt.getTime(), before, 'the modified time is the file\'s');
});

it('a note is never in a share, never in an emergency answer, and not searchable through the lists', async () => {
  const a = await account('note.share@example.com');
  const id = await upload(a, 'n.txt');
  await setNote(a, id, 'PRIVATE-NOTE-TEXT');
  const share = await live.api('POST', `${D}/${id}/share`, { token: a.token, json: { durationHours: 24 } });
  assert.equal(share.status, 201, share.text);
  const everything = JSON.stringify([
    await M().Share.find({}).lean(), await M().SharedFile.find({}).lean(), (await live.api('GET', '/api/shares', { token: a.token })).text,
  ]);
  assert.ok(!everything.includes('PRIVATE-NOTE-TEXT'));
  const { createSession } = require('../utils/sessionStore');
  const token = await createSession(a.userId, crypto.randomBytes(32), {
    emergency: { accessId: oid(crypto.randomBytes(12).toString('hex')), requestId: oid(crypto.randomBytes(12).toString('hex')), scopeMode: 'all', absoluteMs: 4 * 3600 * 1000 },
  });
  const seen = await live.api('GET', D, { token });
  assert.equal(seen.status, 200, seen.text);
  assert.ok(seen.body.length === 1 && !('hasNote' in seen.body[0]) && !seen.text.includes('PRIVATE'));
  assert.equal((await live.api('PUT', `${D}/${id}/note`, { token, json: { note: 'x' } })).status, 403);
  assert.equal((await live.api('GET', `${D}/${id}/details`, { token })).status, 403);
});

it('Upload new version keeps the id, name, folder, expiry, star and note, and keeps the old contents as a version', async () => {
  const a = await account('ver.a@example.com');
  const id = await upload(a, 'plan.txt', 'first contents', 'Plans');
  await live.api('PATCH', `${D}/${id}`, { token: a.token, json: { expiryDate: '2031-05-04' } });
  await live.api('POST', `${D}/star`, { token: a.token, json: { ids: [id], starred: true } });
  await setNote(a, id, 'my note');
  const before = await rawDoc(id);

  const res = await newVersion(a, id, 'second contents, a bit longer');
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.id, id);
  assert.equal(res.body.filename, 'plan.txt', 'the uploaded name is ignored');
  assert.equal(res.body.size, 'second contents, a bit longer'.length);

  const after = await rawDoc(id);
  assert.equal(after.filename, before.filename);
  assert.equal(after.folder, before.folder);
  assert.equal(String(after.docExpiresAt), String(before.docExpiresAt));
  assert.equal(after.starred, true);
  assert.equal(after.hasNote, true);
  assert.equal(after.noteCipher, before.noteCipher);
  assert.notEqual(after.checksum, before.checksum);
  assert.equal(after.checksum, crypto.createHash('sha256').update('second contents, a bit longer').digest('hex'));
  assert.equal((await view(a, id)).text, 'second contents, a bit longer');

  const d = await details(a, id);
  assert.equal(d.size, 'second contents, a bit longer'.length);
  assert.equal(d.versions.length, 1);
  const [v] = d.versions;
  assert.equal(v.version, 1);
  assert.equal(v.size, 'first contents'.length);
  assert.ok(v.device, 'the device that made the change');
  assert.equal(v.thisDevice, true);
  assert.deepEqual(d.versionLimits, { max: 3, days: 30 });
  const days = (new Date(v.expiresAt) - new Date(v.createdAt)) / 864e5;
  assert.ok(Math.abs(days - 30) < 0.01, `expires 30 days later (${days})`);
  assert.ok(!/encryptedBlob|authTag|checksum|"iv"/.test(JSON.stringify(d.versions)));
  const stored = await M().DocumentVersion.collection.findOne({});
  assert.ok(Buffer.isBuffer(stored.encryptedBlob.buffer) || stored.encryptedBlob);
  assert.ok(!JSON.stringify(stored).includes('first contents'));
  assert.equal(String(stored.documentId), id);
  assert.equal(String(stored.userId), String(a.userId));
});

it('a new version goes through the upload rules: the size cap, sniffing of the bytes, an identical file, a missing file', async () => {
  const a = await account('ver.rules@example.com');
  const id = await upload(a, 'pic.txt', 'plain words');
  assert.equal((await rawDoc(id)).sniffedType, 'none');
  const tooBig = await newVersion(a, id, Buffer.alloc(4 * 1024 * 1024 + 10, 1));
  assert.equal(tooBig.status, 413, 'the same 4MB cap');
  assert.equal((await details(a, id)).versions.length, 0);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  assert.equal((await newVersion(a, id, png, 'text/plain')).status, 201);
  assert.equal((await rawDoc(id)).sniffedType, 'image/png', 'the bytes decide the type, not the claimed one');
  assert.equal((await rawDoc(id)).mimeType, 'text/plain');

  assert.equal((await newVersion(a, id, png)).status, 409, 'identical to the current contents');
  const none = await live.api('POST', `${D}/${id}/versions`, { token: a.token, form: new FormData() });
  assert.equal(none.status, 400);
  assert.equal((await details(a, id)).versions.length, 1);
  await live.api('DELETE', `${D}/${id}`, { token: a.token });
  assert.equal((await newVersion(a, id, 'later')).status, 404);
});

it('a fourth version deletes the oldest; at most 3 are kept; numbers are never reused', async () => {
  const a = await account('ver.four@example.com');
  const id = await upload(a, 'f.txt', 'v0');
  for (const text of ['v1', 'v2', 'v3', 'v4']) assert.equal((await newVersion(a, id, text)).status, 201);
  const d = await details(a, id);
  assert.deepEqual(d.versions.map((v) => v.version), [4, 3, 2], 'v0 (number 1) went when the fourth was made');
  assert.equal(d.versions.length, 3);
  assert.equal(await M().DocumentVersion.countDocuments({ documentId: oid(id) }), 3);
  assert.equal((await view(a, id)).text, 'v4');
  const events = await M().AuditEvent.find({ userId: a.userId, type: 'version_created' }).lean();
  assert.equal(events.length, 4);
});

it('restore swaps the current file with the chosen version, and leaves shares, expiry, folder, star and note alone', async () => {
  const a = await account('ver.restore@example.com');
  const id = await upload(a, 'doc.txt', 'old contents', 'Docs');
  await live.api('PATCH', `${D}/${id}`, { token: a.token, json: { expiryDate: '2031-05-04' } });
  await live.api('POST', `${D}/star`, { token: a.token, json: { ids: [id], starred: true } });
  await setNote(a, id, 'keep me');
  const share = await live.api('POST', `${D}/${id}/share`, { token: a.token, json: { durationHours: 24 } });
  assert.equal(share.status, 201, share.text);
  await newVersion(a, id, 'new contents here');
  const chosen = (await details(a, id)).versions[0];
  const sharesBefore = JSON.stringify([await M().Share.find({}).lean(), await M().SharedFile.find({}).lean()]);
  const rowBefore = await rawDoc(id);

  const res = await live.api('POST', `${D}/${id}/versions/${chosen.id}/restore`, { token: a.token });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.size, 'old contents'.length);

  assert.equal((await view(a, id)).text, 'old contents', 'the chosen version is current');
  const row = await rawDoc(id);
  assert.equal(row.checksum, crypto.createHash('sha256').update('old contents').digest('hex'), 'checksum follows the contents');
  assert.equal(row.folder, rowBefore.folder);
  assert.equal(String(row.docExpiresAt), String(rowBefore.docExpiresAt));
  assert.equal(row.starred, true);
  assert.equal(row.noteCipher, rowBefore.noteCipher);
  assert.equal(JSON.stringify([await M().Share.find({}).lean(), await M().SharedFile.find({}).lean()]), sharesBefore, 'the share holds its own copy: untouched');
  assert.equal((await details(a, id)).shared.count, 1, 'and still active');

  const d = await details(a, id);
  assert.equal(d.size, 'old contents'.length);
  assert.equal(d.versions.length, 1, 'the restored one is not kept twice');
  assert.equal(d.versions[0].size, 'new contents here'.length, 'what was current is now a version');
  const restoreAgain = await live.api('POST', `${D}/${id}/versions/${d.versions[0].id}/restore`, { token: a.token });
  assert.equal(restoreAgain.status, 200);
  assert.equal((await view(a, id)).text, 'new contents here');
  const events = await M().AuditEvent.find({ userId: a.userId, type: 'version_restored' }).lean();
  assert.equal(events.length, 2);
});

it('a version can be downloaded (its own bytes, checked) and deleted; a version of another file is not found', async () => {
  const a = await account('ver.dl@example.com');
  const id = await upload(a, 'doc.txt', 'the first words');
  const other = await upload(a, 'other.txt', 'unrelated');
  await newVersion(a, id, 'the second words');
  const [v] = (await details(a, id)).versions;
  const dl = await live.api('GET', `${D}/${id}/versions/${v.id}/download`, { token: a.token });
  assert.equal(dl.status, 200);
  assert.equal(dl.text, 'the first words');
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
  assert.equal(dl.headers.get('cache-control'), 'no-store');
  assert.equal((await live.api('GET', `${D}/${other}/versions/${v.id}/download`, { token: a.token })).status, 404, 'a version only through its own file');
  assert.equal((await live.api('GET', `${D}/${id}/versions/${'0'.repeat(24)}/download`, { token: a.token })).status, 404);
  assert.equal((await live.api('GET', `${D}/${id}/versions/nope/download`, { token: a.token })).status, 404);

  await M().DocumentVersion.collection.updateOne({ _id: oid(v.id) }, { $set: { checksum: 'f'.repeat(64) } });
  assert.equal((await live.api('GET', `${D}/${id}/versions/${v.id}/download`, { token: a.token })).status, 500);
  await M().DocumentVersion.collection.updateOne({ _id: oid(v.id) }, { $set: { checksum: crypto.createHash('sha256').update('the first words').digest('hex') } });

  assert.equal((await live.api('DELETE', `${D}/${id}/versions/${v.id}`, { token: a.token })).status, 204);
  assert.equal(await M().DocumentVersion.countDocuments({}), 0, 'the record and its bytes are gone');
  assert.equal((await details(a, id)).versions.length, 0);
  assert.equal((await live.api('DELETE', `${D}/${id}/versions/${v.id}`, { token: a.token })).status, 404);
  assert.equal((await view(a, id)).text, 'the second words', 'the current file is untouched');
  const types = (await M().AuditEvent.find({ userId: a.userId, type: /^version_/ }).sort({ seq: 1 }).lean()).map((event) => event.type);
  assert.deepEqual(types, ['version_created', 'version_deleted']);
});

it('user B cannot read, set, restore, download or delete notes or versions of user A, and nothing of A changes', async () => {
  const a = await account('iso.a@example.com');
  const b = await account('iso.b@example.com');
  const id = await upload(a, 'secret.txt', 'A original');
  await setNote(a, id, 'A private note');
  await newVersion(a, id, 'A replaced');
  const [v] = (await details(a, id)).versions;
  const snapshot = async () => JSON.stringify([await M().Document.find({ userId: a.userId }).lean(), await M().DocumentVersion.find({ userId: a.userId }).lean()]);
  const before = await snapshot();

  const calls = [
    ['GET', `${D}/${id}/details`], ['PUT', `${D}/${id}/note`, { note: 'planted' }], ['PUT', `${D}/${id}/note`, { note: null }],
    ['POST', `${D}/${id}/versions/${v.id}/restore`], ['GET', `${D}/${id}/versions/${v.id}/download`], ['DELETE', `${D}/${id}/versions/${v.id}`],
  ];
  for (const [method, path, json] of calls) {
    const res = await live.api(method, path, { token: b.token, json });
    assert.equal(res.status, 404, `${method} ${path}: ${res.text}`);
    assert.ok(!res.text.includes('A private note') && !res.text.includes('A original'));
  }
  const upload404 = await newVersion(b, id, 'planted by B');
  assert.equal(upload404.status, 404);
  assert.equal(await snapshot(), before, 'A\'s rows are exactly as they were');
  const mine = await upload(b, 'mine.txt', 'B file');
  assert.equal((await live.api('POST', `${D}/${mine}/versions/${v.id}/restore`, { token: b.token })).status, 404);
  assert.equal((await live.api('GET', `${D}/${mine}/versions/${v.id}/download`, { token: b.token })).status, 404);
  assert.equal(await snapshot(), before);
  assert.equal((await live.api('GET', `${D}/${id}/versions/${v.id}/download`)).status, 401);
});

it('an emergency session is refused on every new route', async () => {
  const { createSession } = require('../utils/sessionStore');
  const a = await account('ver.emergency@example.com');
  const id = await upload(a, 'e.txt', 'one');
  await newVersion(a, id, 'two');
  const [v] = (await details(a, id)).versions;
  const token = await createSession(a.userId, crypto.randomBytes(32), {
    emergency: { accessId: oid(crypto.randomBytes(12).toString('hex')), requestId: oid(crypto.randomBytes(12).toString('hex')), scopeMode: 'all', absoluteMs: 4 * 3600 * 1000 },
  });
  const calls = [
    ['PUT', `${D}/${id}/note`, { note: 'x' }], ['POST', `${D}/${id}/versions`], ['POST', `${D}/${id}/versions/${v.id}/restore`],
    ['DELETE', `${D}/${id}/versions/${v.id}`], ['GET', `${D}/${id}/versions/${v.id}/download`], ['GET', `${D}/${id}/details`],
  ];
  for (const [method, path, json] of calls) {
    const res = await live.api(method, path, { token, json });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.body.error.code, 'EMERGENCY_READ_ONLY');
  }
  assert.equal((await view(a, id)).text, 'two');
  assert.equal(await M().DocumentVersion.countDocuments({}), 1);
});

it('each new route counts against its own per-account bucket', async () => {
  const a = await account('ver.limits@example.com');
  const id = await upload(a, 'l.txt', 'one');
  await newVersion(a, id, 'two');
  const [v] = (await details(a, id)).versions;
  const RateLimit = M().RateLimit;
  const hit = async (method, path, extra = {}) => {
    const res = await live.api(method, path, { token: a.token, ...extra });
    assert.ok(res.status < 500, `${method} ${path} -> ${res.status}`);
    return (await RateLimit.find({}).lean()).map((row) => row.bucket);
  };
  assert.ok((await hit('PUT', `${D}/${id}/note`, { json: { note: 'n' } })).includes('docs-note'));
  assert.ok((await hit('POST', `${D}/${id}/versions`, { form: formOf('x.txt', 'three') })).includes('docs-version-upload'));
  assert.ok((await hit('GET', `${D}/${id}/versions/${v.id}/download`)).includes('docs-version-download'));
  assert.ok((await hit('POST', `${D}/${id}/versions/${v.id}/restore`)).includes('docs-version-restore'));
  const [next] = (await details(a, id)).versions;
  assert.ok((await hit('DELETE', `${D}/${id}/versions/${next.id}`)).includes('docs-version-delete'));
});

it('version bytes count against the quota: a new version that would not fit is refused with the normal upload error', async () => {
  const a = await account('ver.quota@example.com');
  const id = await upload(a, 'q.bin', Buffer.alloc(300 * 1024, 1));
  assert.equal((await newVersion(a, id, Buffer.alloc(300 * 1024, 2))).status, 201, 'room for it');
  const usage = (await live.api('GET', `${D}/storage`, { token: a.token })).body;
  assert.equal(usage.versionBytes, 300 * 1024);
  assert.equal(usage.versionCount, 1);
  assert.equal(usage.usedBytes, usage.fileBytes + usage.trashBytes + usage.versionBytes, 'one meter: files + Trash + versions');

  process.env.STORAGE_QUOTA_MB = '1';
  const versionsBefore = await M().DocumentVersion.countDocuments({});
  const blocked = await newVersion(a, id, Buffer.alloc(600 * 1024, 3));
  assert.equal(blocked.status, 413);
  assert.equal(blocked.body.error.code, 'STORAGE_QUOTA');
  const normal = await live.api('POST', D, { token: a.token, form: formOf('n.bin', Buffer.alloc(600 * 1024, 3)) });
  assert.equal(normal.status, 413);
  assert.equal(normal.body.error.code, blocked.body.error.code, 'the same error as a normal upload');
  assert.equal(await M().DocumentVersion.countDocuments({}), versionsBefore, 'nothing was stored');
  assert.equal((await view(a, id)).status, 200);
  assert.equal((await newVersion(a, id, Buffer.alloc(100 * 1024, 4))).status, 201);
});

it('when three versions are kept, the one that is deleted for the fourth frees its bytes for the quota check', async () => {
  const a = await account('ver.quota2@example.com');
  const id = await upload(a, 'q.bin', Buffer.alloc(100 * 1024, 0));
  for (const fill of [1, 2, 3]) assert.equal((await newVersion(a, id, Buffer.alloc(100 * 1024, fill))).status, 201);
  process.env.STORAGE_QUOTA_MB = String(410 / 1024);
  assert.equal((await newVersion(a, id, Buffer.alloc(100 * 1024, 4))).status, 201, 'net change is nothing');
  assert.equal((await details(a, id)).versions.length, 3);
});

it('purging a file from Trash, emptying Trash, a file removed by the database TTL, and account deletion all leave no version behind', async () => {
  const a = await account('ver.purge@example.com');
  const b = await account('ver.purge.b@example.com');
  const made = async (user, name) => {
    const id = await upload(user, name, `${name} 0`);
    await newVersion(user, id, `${name} 1`);
    await newVersion(user, id, `${name} 2`);
    return id;
  };
  const one = await made(a, 'one.txt');
  const two = await made(a, 'two.txt');
  const three = await made(a, 'three.txt');
  const four = await made(a, 'four.txt');
  const bFile = await made(b, 'bee.txt');
  assert.equal(await M().DocumentVersion.countDocuments({}), 10);
  assert.deepEqual(await orphanVersions(), []);

  await live.api('DELETE', `${D}/${one}`, { token: a.token });
  assert.equal(await M().DocumentVersion.countDocuments({ documentId: oid(one) }), 2, 'in Trash it still has its versions (they count in the quota)');
  assert.equal((await live.api('DELETE', `/api/trash/file/${one}`, { token: a.token })).status, 204);
  assert.equal(await M().DocumentVersion.countDocuments({ documentId: oid(one) }), 0);

  await live.api('DELETE', `${D}/${two}`, { token: a.token });
  assert.ok([200, 204].includes((await live.api('DELETE', '/api/trash', { token: a.token })).status));
  assert.equal(await M().DocumentVersion.countDocuments({ documentId: oid(two) }), 0);

  await live.api('DELETE', `${D}/${three}`, { token: a.token });
  await M().Document.collection.deleteOne({ _id: oid(three) });
  assert.equal((await orphanVersions()).length, 1, 'the scan finds the leftover');
  const { purgeExpired } = require('../utils/trash');
  await purgeExpired(a.userId);
  assert.deepEqual(await orphanVersions(), [], 'and the purge removed it');
  await M().Document.collection.deleteOne({ _id: oid(four) });
  assert.equal((await orphanVersions()).length, 1);
  assert.equal((await live.api('GET', D, { token: a.token })).status, 200);
  assert.deepEqual(await orphanVersions(), []);
  assert.equal(await M().DocumentVersion.countDocuments({ userId: b.userId }), 2, "another account's versions were not touched");

  const { deleteAccountData } = require('../utils/accountDeletion');
  const deleted = await deleteAccountData(b.userId, { email: b.email, transaction: false });
  assert.equal(deleted.documentversions, 2);
  assert.equal(await M().DocumentVersion.countDocuments({}), 0);
  assert.equal(await M().Document.countDocuments({ _id: oid(bFile) }), 0);
  assert.deepEqual(await orphanVersions(), []);
});

it('a version expires after 30 days: the TTL index is on expiresAt (the Trash pattern) and the migration builds it', async () => {
  const a = await account('ver.ttl@example.com');
  const id = await upload(a, 't.txt', 'one');
  await newVersion(a, id, 'two');
  const indexes = await M().DocumentVersion.collection.indexes();
  const ttl = indexes.find((index) => index.key.expiresAt === 1);
  assert.equal(ttl.expireAfterSeconds, 0);
  const row = await M().DocumentVersion.collection.findOne({});
  const days = (row.expiresAt - row.createdAt) / 864e5;
  assert.ok(Math.abs(days - 30) < 0.01);
  await M().DocumentVersion.collection.updateOne({ _id: row._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  await M().DocumentVersion.collection.deleteMany({ expiresAt: { $lte: new Date() } });
  assert.equal(await M().DocumentVersion.countDocuments({}), 0);
  assert.equal((await details(a, id)).versions.length, 0);
  assert.equal((await view(a, id)).text, 'two');
});

it('a password-reset "start over" wipe takes the versions with the files', async () => {
  const a = await account('ver.wipe@example.com');
  const id = await upload(a, 'w.txt', 'one');
  await newVersion(a, id, 'two');
  const { wipeVault } = require('../utils/accountReset');
  await wipeVault(a.userId);
  assert.equal(await M().DocumentVersion.countDocuments({}), 0);
  assert.deepEqual(await orphanVersions(), []);
});
