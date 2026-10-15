// Run with: cd server && npm test
//
// Starred, Recent, the details panel, folder colours and icons, and the batch move / batch trash behind bulk selection.
// The REAL app on a LOCAL throwaway MongoDB (skipped, with the reason, without one); mail is captured, no .env is read.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { startLiveApp } = require('./helpers/liveApp');
const { FOLDER_COLORS, FOLDER_ICONS, parseFolderStyle } = require('../utils/folderStyle');

const PASSWORD = 'Qx7!vTr29#mLpw';
let live = { ok: false, reason: '' };

test.before(async () => {
  live = await startLiveApp('drive_basics');
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
async function upload(user, name, { folder, content } = {}) {
  const form = new FormData();
  form.append('file', new Blob([content ?? `content of ${name} `.repeat(5)], { type: 'text/plain' }), name);
  if (folder) form.append('folder', folder);
  const res = await live.api('POST', '/api/documents', { token: user.token, form });
  assert.equal(res.status, 201, res.text);
  return res.body.id;
}
const list = async (user) => (await live.api('GET', '/api/documents', { token: user.token })).body;
const D = '/api/documents';
const raw = (id) => live.mongoose.models.Document.collection.findOne({ _id: new live.mongoose.Types.ObjectId(id) });

// ---------------- 1. starred ----------------

it('a star is set and cleared for one file or a batch, shows in the list, and is not a change to the file', async () => {
  const a = await account('star.a@example.com');
  const ids = [await upload(a, 'one.txt'), await upload(a, 'two.txt'), await upload(a, 'three.txt')];
  const before = (await raw(ids[0])).updatedAt;

  assert.deepEqual((await live.api('POST', `${D}/star`, { token: a.token, json: { ids: [ids[0]], starred: true } })).body, { starred: true, updatedCount: 1 });
  assert.equal((await live.api('POST', `${D}/star`, { token: a.token, json: { ids: [ids[1], ids[2]], starred: true } })).body.updatedCount, 2);
  const stars = Object.fromEntries((await list(a)).map((doc) => [doc.id, doc.starred]));
  assert.deepEqual(Object.values(stars), [true, true, true]);
  assert.equal((await raw(ids[0])).updatedAt.getTime(), before.getTime(), '"modified" did not move');

  await live.api('POST', `${D}/star`, { token: a.token, json: { ids: [ids[0]], starred: false } });
  const after = Object.fromEntries((await list(a)).map((doc) => [doc.id, doc.starred]));
  assert.equal(after[ids[0]], false);
  assert.equal(after[ids[1]], true);
  // a document from before stars existed reads as not starred
  await live.mongoose.models.Document.collection.updateOne({ _id: new live.mongoose.Types.ObjectId(ids[2]) }, { $unset: { starred: 1 } });
  assert.equal((await list(a)).find((doc) => doc.id === ids[2]).starred, false);
});

it('star input is validated: 1 to 50 text ids and a real boolean; bad ids and Trash are ignored, never revealed', async () => {
  const a = await account('star.valid@example.com');
  const id = await upload(a, 'v.txt');
  const star = (json) => live.api('POST', `${D}/star`, { token: a.token, json });
  for (const bad of [
    { starred: true }, { ids: 'x', starred: true }, { ids: [], starred: true }, { ids: Array(51).fill(id), starred: true },
    { ids: [{ $ne: 1 }], starred: true }, { ids: [5], starred: true }, { ids: ['x'.repeat(65)], starred: true },
    { ids: [id], starred: 'true' }, { ids: [id], starred: 1 }, { ids: [id] },
  ]) assert.equal((await star(bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  assert.equal((await star({ ids: Array(50).fill(id), starred: true })).status, 200, 'exactly 50 is allowed');
  // not-an-id, someone else's id and a missing id all look the same: they are simply not counted
  const result = await star({ ids: ['nonsense', new live.mongoose.Types.ObjectId().toString(), id], starred: false });
  assert.deepEqual(result.body, { starred: false, updatedCount: 1 });
  // a trashed file cannot be starred
  await live.api('DELETE', `${D}/${id}`, { token: a.token });
  assert.equal((await star({ ids: [id], starred: true })).body.updatedCount, 0);
});

it('user B cannot star, and a batch with A\'s id changes none of A\'s files', async () => {
  const a = await account('star.owner@example.com');
  const b = await account('star.other@example.com');
  const aDoc = await upload(a, 'private.txt');
  const bDoc = await upload(b, 'mine.txt');
  const snapshot = JSON.stringify(await raw(aDoc), (key, value) => (key === 'encryptedBlob' ? undefined : value));
  const res = await live.api('POST', `${D}/star`, { token: b.token, json: { ids: [aDoc, bDoc], starred: true } });
  assert.equal(res.body.updatedCount, 1, 'only B\'s own file');
  assert.equal(JSON.stringify(await raw(aDoc), (key, value) => (key === 'encryptedBlob' ? undefined : value)), snapshot, 'A\'s file is byte for byte as it was');
  assert.equal((await list(a))[0].starred, false);
});

it('"frequently used" puts starred files first', async () => {
  const a = await account('freq.star@example.com');
  const popular = await upload(a, 'popular.txt');
  const starred = await upload(a, 'starred.txt');
  for (let i = 0; i < 3; i += 1) await live.api('GET', `${D}/${popular}/view`, { token: a.token });
  await live.api('GET', `${D}/${starred}/view`, { token: a.token });
  let items = (await live.api('GET', '/api/insights/frequent', { token: a.token })).body.items;
  assert.deepEqual(items.map((item) => item.filename), ['popular.txt', 'starred.txt']);
  await live.api('POST', `${D}/star`, { token: a.token, json: { ids: [starred], starred: true } });
  items = (await live.api('GET', '/api/insights/frequent', { token: a.token })).body.items;
  assert.deepEqual(items.map((item) => [item.filename, item.starred]), [['starred.txt', true], ['popular.txt', false]]);
});

// ---------------- 2. recent ----------------

it('Recent: the last 30 touched files, newest first, with the device that last opened each, never Trash, never another account\'s', async () => {
  const a = await account('recent.a@example.com');
  const b = await account('recent.b@example.com');
  const ids = [];
  for (let i = 0; i < 32; i += 1) ids.push(await upload(a, `file-${String(i).padStart(2, '0')}.txt`)); // eslint-disable-line no-await-in-loop
  await upload(b, 'b-only.txt');
  await live.api('GET', `${D}/${ids[0]}/view`, { token: a.token }); // the OLDEST upload is now the newest activity
  await live.api('DELETE', `${D}/${ids[31]}`, { token: a.token }); // the newest upload goes to Trash

  const res = await live.api('GET', `${D}/recent`, { token: a.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.retentionDays, 30);
  assert.equal(res.body.items.length, 30, 'capped at 30');
  assert.equal(res.body.items[0].filename, 'file-00.txt', 'newest activity first');
  assert.equal(res.body.items[0].lastActivity.type, 'view');
  assert.equal(typeof res.body.items[0].openedOnDevice, 'string', 'the device that opened it');
  assert.equal(res.body.items[0].openedOnThisDevice, true);
  assert.equal(res.body.items[1].filename, 'file-30.txt', 'then the next newest upload');
  assert.equal(res.body.items[1].openedOnDevice, null, 'never opened: no device');
  assert.ok(!res.body.items.some((item) => item.filename === 'file-31.txt'), 'Trash is left out');
  assert.ok(!res.body.items.some((item) => item.filename === 'b-only.txt'));
  const times = res.body.items.map((item) => new Date(item.lastActivity.at).getTime());
  assert.deepEqual(times, [...times].sort((x, y) => y - x));
  assert.ok(res.body.items.every((item) => 'size' in item && 'starred' in item && !('encryptedBlob' in item)));

  const other = await live.api('GET', `${D}/recent`, { token: b.token });
  assert.deepEqual(other.body.items.map((item) => item.filename), ['b-only.txt']);
});

it('Recent reaches back only as far as the activity log: an old event is not shown, and an empty vault is an empty list', async () => {
  const a = await account('recent.old@example.com');
  assert.deepEqual((await live.api('GET', `${D}/recent`, { token: a.token })).body, { retentionDays: 30, items: [] });
  const id = await upload(a, 'old.txt');
  await live.mongoose.models.AuditEvent.deleteMany({ userId: a.userId, targetId: id }); // what the 30-day expiry does
  assert.deepEqual((await live.api('GET', `${D}/recent`, { token: a.token })).body.items, []);
});

// ---------------- 3. the details panel ----------------

it('details: one answer with the facts, sharing, purpose, a 12-character fingerprint and the last 5 activities, and no secrets', async () => {
  const a = await account('details.a@example.com');
  const id = await upload(a, 'passport.txt', { folder: 'Travel' });
  await live.api('PATCH', `${D}/${id}`, { token: a.token, json: { docExpiresAt: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10) } });
  const sharedA = await live.api('POST', `${D}/${id}/share`, { token: a.token, json: { durationHours: 24, purpose: 'Visa application' } });
  assert.equal(sharedA.status, 201, sharedA.text);
  await live.api('POST', `${D}/${id}/share`, { token: a.token, json: { durationHours: 48 } });
  for (let i = 0; i < 4; i += 1) await live.api('GET', `${D}/${id}/view`, { token: a.token });
  await live.api('POST', `${D}/star`, { token: a.token, json: { ids: [id], starred: true } });

  const res = await live.api('GET', `${D}/${id}/details`, { token: a.token });
  assert.equal(res.status, 200);
  const body = res.body;
  assert.equal(body.name, 'passport.txt');
  assert.equal(body.folder, 'Travel');
  assert.ok('type' in body, 'the type the bytes showed (null until classified)');
  assert.equal(body.mimeType, 'text/plain');
  assert.ok(body.size > 0 && body.createdAt && body.updatedAt);
  assert.equal(body.daysUntilExpiry, 5);
  assert.equal(body.starred, true);
  assert.equal(body.shared.count, 2);
  assert.equal(body.shared.links.length, 2);
  assert.ok(body.shared.links.every((link) => new Date(link.expiresAt).getTime() > Date.now()));
  assert.deepEqual(body.purposes, ['Visa application']);
  const full = (await raw(id)).checksum;
  assert.equal(body.fingerprint, full.slice(0, 12));
  assert.equal(body.activity.length, 5, 'the last five');
  assert.equal(body.activity[0].type, 'view');
  assert.ok(body.activity.every((entry) => typeof entry.device === 'string' && entry.thisDevice === true));
  const times = body.activity.map((entry) => new Date(entry.at).getTime());
  assert.deepEqual(times, [...times].sort((x, y) => y - x));

  // nothing secret in it, anywhere
  const text = res.text;
  const row = await raw(id);
  for (const secret of [full, row.iv, row.authTag, row.encryptedBlob.toString('base64').slice(0, 24)]) assert.ok(!text.includes(secret), 'no checksum, IV, tag or ciphertext');
  assert.doesNotMatch(text, /wrapped|storage|path":|"iv"|authTag|encryptedBlob|dek|"key"/i);
  assert.deepEqual(Object.keys(body).sort(), ['activity', 'createdAt', 'daysUntilExpiry', 'expiresAt', 'expiryStatus', 'fingerprint', 'folder', 'hasNote', 'id', 'mimeType', 'name', 'note', 'purposes', 'shared', 'size', 'starred', 'type', 'updatedAt', 'versionLimits', 'versions']);
});

it('details: another account\'s file, a trashed file and a bad id are all the same 404', async () => {
  const a = await account('details.owner@example.com');
  const b = await account('details.other@example.com');
  const id = await upload(a, 'mine.txt');
  const missing = await live.api('GET', `${D}/${new live.mongoose.Types.ObjectId()}/details`, { token: b.token });
  for (const probe of [live.api('GET', `${D}/${id}/details`, { token: b.token }), live.api('GET', `${D}/not-an-id/details`, { token: b.token })]) {
    const res = await probe;
    assert.equal(res.status, 404);
    assert.equal(res.text, missing.text, 'indistinguishable from a file that does not exist');
  }
  await live.api('DELETE', `${D}/${id}`, { token: a.token });
  assert.equal((await live.api('GET', `${D}/${id}/details`, { token: a.token })).status, 404);
});

// ---------------- 4. folder colours and icons ----------------

it('folders take a colour and an icon from the server lists; anything else is refused', async () => {
  assert.equal(FOLDER_COLORS.length, 8);
  assert.ok(FOLDER_ICONS.length >= 12 && FOLDER_ICONS.includes('id-card') && FOLDER_ICONS.includes('graduation-cap'));
  const a = await account('style.a@example.com');
  const make = (json) => live.api('POST', `${D}/folders`, { token: a.token, json });
  assert.equal((await make({ name: 'IDs', parentPath: '', color: 'blue', icon: 'id-card' })).status, 201);
  for (const bad of [{ color: 'purple' }, { color: '#ff0000' }, { color: 'javascript:alert(1)' }, { color: ['blue'] }, { color: { $ne: 1 } }, { color: 'x'.repeat(40) }, { icon: 'skull' }, { icon: '<img src=x>' }, { icon: 5 }]) {
    const res = await make({ name: `Bad${Math.random()}`, parentPath: '', ...bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  assert.equal(await live.mongoose.models.Folder.countDocuments({ userId: a.userId }), 1, 'a refused request made no folder');
  for (const color of FOLDER_COLORS) assert.deepEqual(parseFolderStyle({ color }).set, { color });
  for (const icon of FOLDER_ICONS) assert.deepEqual(parseFolderStyle({ icon }).set, { icon });
  assert.deepEqual(parseFolderStyle({ color: null, icon: '' }).unset, { color: 1, icon: 1 });
  assert.deepEqual(parseFolderStyle({}), { set: {}, unset: {} });
});

it('the look rides on the folder answers (no extra request), and old folders keep the default look', async () => {
  const a = await account('style.list@example.com');
  await live.api('POST', `${D}/folders`, { token: a.token, json: { name: 'Plain', parentPath: '' } });
  await live.api('POST', `${D}/folders`, { token: a.token, json: { name: 'Health', parentPath: '', color: 'rose', icon: 'heart' } });
  await live.api('POST', `${D}/folders`, { token: a.token, json: { name: 'Child', parentPath: 'Health', color: 'teal' } });
  const root = (await live.api('GET', `${D}/folders/children`, { token: a.token, query: { path: '' } })).body;
  assert.deepEqual(root.folders.map((f) => [f.name, f.color, f.icon]), [['Health', 'rose', 'heart'], ['Plain', null, null]]);
  assert.deepEqual(root.styles, { Health: { color: 'rose', icon: 'heart' }, 'Health/Child': { color: 'teal', icon: null } }, 'every styled folder by path; the plain one is not listed');
  const sub = (await live.api('GET', `${D}/folders/children`, { token: a.token, query: { path: 'Health' } })).body;
  assert.deepEqual(sub.folders.map((f) => [f.name, f.color, f.icon]), [['Child', 'teal', null]]);
  assert.ok(!('styles' in sub), 'only the top-level answer carries the map');
  // the plain list of folder paths is unchanged
  assert.deepEqual((await live.api('GET', `${D}/folders`, { token: a.token })).body, ['root', 'Health', 'Health/Child', 'Plain']);
});

it('changing the look does not change the path, the unique name or what is inside; renaming keeps the look', async () => {
  const a = await account('style.change@example.com');
  const Folder = live.mongoose.models.Folder;
  await live.api('POST', `${D}/folders`, { token: a.token, json: { name: 'Taxes', parentPath: '' } });
  const id = await upload(a, 'return.txt', { folder: 'Taxes' });
  const before = await Folder.findOne({ userId: a.userId, name: 'Taxes' }).lean();
  const patch = (json) => live.api('PATCH', `${D}/folders`, { token: a.token, json });

  assert.equal((await patch({ path: 'Taxes', color: 'green', icon: 'receipt' })).body.path, 'Taxes');
  let now = await Folder.findOne({ userId: a.userId, name: 'Taxes' }).lean();
  assert.deepEqual([now.parentPath, now.name, now.nameKey, String(now._id)], [before.parentPath, before.name, before.nameKey, String(before._id)]);
  assert.deepEqual([now.color, now.icon], ['green', 'receipt']);
  assert.equal((await raw(id)).folder, 'Taxes');

  assert.equal((await patch({ path: 'Taxes', color: 'amber' })).status, 200, 'one field at a time');
  now = await Folder.findOne({ userId: a.userId, name: 'Taxes' }).lean();
  assert.deepEqual([now.color, now.icon], ['amber', 'receipt']);
  assert.equal((await patch({ path: 'Taxes', name: 'Taxes 2026' })).body.path, 'Taxes 2026');
  now = await Folder.findOne({ userId: a.userId, name: 'Taxes 2026' }).lean();
  assert.deepEqual([now.color, now.icon], ['amber', 'receipt'], 'a rename keeps the look');
  assert.equal((await raw(id)).folder, 'Taxes 2026');
  assert.equal((await patch({ path: 'Taxes 2026', color: null, icon: null })).status, 200);
  now = await Folder.findOne({ userId: a.userId, name: 'Taxes 2026' }).lean();
  assert.ok(!('color' in now) && !('icon' in now), 'back to the default look');

  assert.equal((await patch({ path: 'Taxes 2026', color: 'pink' })).status, 400);
  assert.equal((await patch({ path: 'Taxes 2026' })).status, 400, 'something to change is required');
  assert.equal((await patch({ path: 'Taxes 2026', name: 'Valid', color: 'nope' })).status, 400);
  assert.equal(await Folder.countDocuments({ userId: a.userId, name: 'Valid' }), 0, 'a refused style stops the rename too');
  // the unique index still holds: the same name in the same place is a clash
  await live.api('POST', `${D}/folders`, { token: a.token, json: { name: 'Other', parentPath: '' } });
  assert.equal((await patch({ path: 'Other', name: 'taxes 2026' })).status, 409);
});

it('B cannot restyle A\'s folder: the same answer as for a folder that does not exist', async () => {
  const a = await account('style.owner@example.com');
  const b = await account('style.intruder@example.com');
  await live.api('POST', `${D}/folders`, { token: a.token, json: { name: 'Secret', parentPath: '', color: 'blue' } });
  const res = await live.api('PATCH', `${D}/folders`, { token: b.token, json: { path: 'Secret', color: 'rose', icon: 'heart' } });
  assert.equal(res.status, 404);
  const mine = await live.api('GET', `${D}/folders/children`, { token: b.token, query: { path: '' } });
  assert.deepEqual(mine.body.styles, {});
  const folder = await live.mongoose.models.Folder.findOne({ userId: a.userId }).lean();
  assert.deepEqual([folder.color, folder.icon], ['blue', undefined]);
});

// ---------------- 5. batch move and batch trash ----------------

it('batch move: up to 50 files, a result for each id, conflicts reported, one activity event per file, shares and expiry untouched', async () => {
  const a = await account('batch.a@example.com');
  await live.api('POST', `${D}/folders`, { token: a.token, json: { name: 'Target', parentPath: '' } });
  const ids = [];
  for (let i = 0; i < 4; i += 1) ids.push(await upload(a, `m${i}.txt`)); // eslint-disable-line no-await-in-loop
  await upload(a, 'm3.txt', { folder: 'Target' }); // a clash for m3
  const share = await live.api('POST', `${D}/${ids[0]}/share`, { token: a.token, json: { durationHours: 24 } });
  assert.equal(share.status, 201);
  await live.api('PATCH', `${D}/${ids[1]}`, { token: a.token, json: { docExpiresAt: '2031-01-01' } });
  const AuditEvent = live.mongoose.models.AuditEvent;
  const movesBefore = await AuditEvent.countDocuments({ userId: a.userId, type: 'move' });

  const res = await live.api('POST', `${D}/batch/move`, { token: a.token, json: { ids: [...ids, 'junk', new live.mongoose.Types.ObjectId().toString()], destination: 'Target' } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.destination, 'Target');
  assert.equal(res.body.results.length, 6, 'a result for each id');
  const byId = Object.fromEntries(res.body.results.map((r) => [r.id, r]));
  assert.deepEqual([0, 1, 2].map((i) => byId[ids[i]].status), ['moved', 'moved', 'moved']);
  assert.equal(byId[ids[3]].status, 'conflict');
  assert.match(byId[ids[3]].message, /already there/);
  assert.equal(byId.junk.status, 'not_found');
  assert.equal(res.body.movedCount, 3);
  assert.equal(await AuditEvent.countDocuments({ userId: a.userId, type: 'move' }) - movesBefore, 3, 'one event per file moved');
  assert.equal((await raw(ids[3])).folder, 'root', 'the clash did not move');
  assert.equal((await raw(ids[0])).folder, 'Target');
  // the share link still works, the expiry date is unchanged, nothing went to Trash
  const shares = (await live.api('GET', '/api/shares', { token: a.token })).body.shares;
  assert.equal(shares.length, 1);
  assert.equal((await raw(ids[1])).docExpiresAt.toISOString().slice(0, 10), '2031-01-01');
  assert.equal(await live.mongoose.models.Document.countDocuments({ userId: a.userId, deletedAt: { $ne: null } }), 0);
  // moving again: "already there"
  const again = await live.api('POST', `${D}/batch/move`, { token: a.token, json: { ids: [ids[0]], destination: 'Target' } });
  assert.equal(again.body.results[0].status, 'unchanged');
});

it('batch input is validated: 1 to 50 text ids, a text destination that exists', async () => {
  const a = await account('batch.valid@example.com');
  const id = await upload(a, 'x.txt');
  for (const route of ['move', 'trash']) {
    const call = (json) => live.api('POST', `${D}/batch/${route}`, { token: a.token, json });
    for (const bad of [{}, { ids: [] }, { ids: 'x' }, { ids: Array(51).fill(id) }, { ids: [1] }, { ids: [null] }, { ids: [{ $gt: '' }] }, { ids: ['y'.repeat(65)] }]) {
      assert.equal((await call({ ...bad, destination: '' })).status, 400, `${route} ${JSON.stringify(bad).slice(0, 50)}`);
    }
  }
  assert.equal((await live.api('POST', `${D}/batch/move`, { token: a.token, json: { ids: [id] } })).status, 400, 'destination is required');
  assert.equal((await live.api('POST', `${D}/batch/move`, { token: a.token, json: { ids: [id], destination: { $ne: 1 } } })).status, 400);
  assert.equal((await live.api('POST', `${D}/batch/move`, { token: a.token, json: { ids: [id], destination: 'x'.repeat(1001) } })).status, 400);
  assert.equal((await live.api('POST', `${D}/batch/move`, { token: a.token, json: { ids: [id], destination: 'No/Such/Folder' } })).status, 404);
  assert.equal((await live.api('POST', `${D}/batch/move`, { token: a.token, json: { ids: Array(50).fill(id), destination: '' } })).status, 200, '50 is the limit, and allowed');
});

it('batch move and trash: a batch with another account\'s id moves and trashes none of their files', async () => {
  const a = await account('batch.victim@example.com');
  const b = await account('batch.attacker@example.com');
  await live.api('POST', `${D}/folders`, { token: b.token, json: { name: 'Dest', parentPath: '' } });
  const aDocs = [await upload(a, 'a1.txt'), await upload(a, 'a2.txt')];
  const bDoc = await upload(b, 'b1.txt');
  const snapshot = async () => JSON.stringify(await Promise.all(aDocs.map(async (id) => ({ ...(await raw(id)), encryptedBlob: undefined }))));
  const before = await snapshot();

  const moved = await live.api('POST', `${D}/batch/move`, { token: b.token, json: { ids: [...aDocs, bDoc], destination: 'Dest' } });
  assert.equal(moved.body.movedCount, 1);
  assert.deepEqual(moved.body.results.filter((r) => r.status === 'not_found').map((r) => r.id).sort(), [...aDocs].sort());
  const trashed = await live.api('POST', `${D}/batch/trash`, { token: b.token, json: { ids: [...aDocs, bDoc] } });
  assert.equal(trashed.body.trashedCount, 1);
  assert.deepEqual(trashed.body.results.filter((r) => r.status === 'not_found').map((r) => r.id).sort(), [...aDocs].sort());
  assert.equal(await snapshot(), before, 'A\'s files are byte for byte as they were');
  assert.equal((await list(a)).length, 2);
  assert.equal(await live.mongoose.models.AuditEvent.countDocuments({ userId: a.userId, type: { $in: ['move', 'delete'] } }), 0, 'and nothing was logged on A\'s account');
});

it('batch trash: files go to Trash with their share links stopped, one event each, outside any Trash folder batch', async () => {
  const a = await account('batch.trash@example.com');
  const ids = [await upload(a, 't1.txt'), await upload(a, 't2.txt'), await upload(a, 't3.txt')];
  await live.api('POST', `${D}/${ids[0]}/share`, { token: a.token, json: { durationHours: 24 } });
  const AuditEvent = live.mongoose.models.AuditEvent;
  const before = await AuditEvent.countDocuments({ userId: a.userId, type: 'delete' });
  const res = await live.api('POST', `${D}/batch/trash`, { token: a.token, json: { ids: [ids[0], ids[1], 'junk'] } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results.map((r) => r.status), ['trashed', 'trashed', 'not_found']);
  assert.equal(await AuditEvent.countDocuments({ userId: a.userId, type: 'delete' }) - before, 2);
  assert.equal((await live.api('GET', '/api/shares', { token: a.token })).body.shares.length, 0, 'the link stopped with the file');
  assert.deepEqual((await list(a)).map((d) => d.id), [ids[2]]);
  const trash = await live.api('GET', '/api/trash', { token: a.token });
  assert.equal(JSON.stringify(trash.body).includes(ids[0]), true, 'it is in Trash');
  const row = await raw(ids[1]);
  assert.ok(row.deletedAt && row.purgeAt && row.trashBatchId === null, 'trashed one by one, not as a folder batch');
  const restore = await live.api('POST', '/api/trash/restore', { token: a.token, json: { kind: 'file', id: ids[1] } });
  assert.equal(restore.status, 200, 'and restorable');
});

// ---------------- budgets, and the emergency allowlist ----------------

it('each new route counts against its own per-account bucket', async () => {
  const a = await account('limits.a@example.com');
  const id = await upload(a, 'l.txt');
  const RateLimit = live.mongoose.models.RateLimit;
  const hit = async (method, path, json) => {
    await RateLimit.deleteMany({});
    const res = await live.api(method, path, { token: a.token, json });
    assert.ok(res.status < 500, `${method} ${path} -> ${res.status}`);
    // (live.api clears the counters BEFORE a request, so what is there now was made by this one)
    return (await RateLimit.find({}).lean()).map((row) => row.bucket);
  };
  assert.ok((await hit('POST', `${D}/star`, { ids: [id], starred: true })).includes('docs-star'));
  assert.ok((await hit('GET', `${D}/recent`)).includes('docs-recent'));
  assert.ok((await hit('GET', `${D}/${id}/details`)).includes('docs-details'));
  assert.ok((await hit('POST', `${D}/batch/move`, { ids: [id], destination: '' })).includes('docs-batch-move'));
  assert.ok((await hit('POST', `${D}/batch/trash`, { ids: [id] })).includes('docs-batch-trash'));
});

it('an emergency session is refused on every new route', async () => {
  const { createSession } = require('../utils/sessionStore');
  const a = await account('emergency.new@example.com');
  const id = await upload(a, 'e.txt');
  const token = await createSession(a.userId, crypto.randomBytes(32), {
    emergency: { accessId: new live.mongoose.Types.ObjectId(), requestId: new live.mongoose.Types.ObjectId(), scopeMode: 'all', absoluteMs: 4 * 3600 * 1000 },
  });
  const calls = [
    ['POST', `${D}/star`, { ids: [id], starred: true }], ['GET', `${D}/recent`], ['GET', `${D}/${id}/details`],
    ['POST', `${D}/batch/move`, { ids: [id], destination: '' }], ['POST', `${D}/batch/trash`, { ids: [id] }],
    ['POST', `${D}/folders`, { name: 'Nope', parentPath: '', color: 'blue' }], ['PATCH', `${D}/folders`, { path: 'x', color: 'blue' }],
  ];
  for (const [method, path, json] of calls) {
    const res = await live.api(method, path, { token, json });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.body.error.code, 'EMERGENCY_READ_ONLY');
  }
  assert.equal((await raw(id)).starred, false);
  assert.equal((await raw(id)).deletedAt, null);
});
