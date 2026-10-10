// Run with: cd server && npm test
//
// Part 0 of the Emergency Access UI work: an emergency session never learns the names of folders ABOVE its scope
// folder (every path starts at the scope root), it can ask who it is (session-info) without learning the owner's
// name or address, and the owner's status screen carries the demo flag, the wait options and recent sessions.
const test = require('node:test');
const assert = require('node:assert/strict');

const W = require('./helpers/emergencyWorld');
const { world, call, E, D, OWNER_EMAIL } = W;
const { toVirtual, toReal, aliasesFor, scopeSummary } = require('../utils/emergency/scope');

async function nestedSession(scopePaths, build) {
  W.reset();
  const folders = {};
  const docs = {};
  build(folders, docs);
  const ids = scopePaths.map((p) => String(Object.values(folders).find((f) => (f.parentPath ? `${f.parentPath}/${f.name}` : f.name) === p)._id));
  const made = await W.setupEmergency({ waitMinutes: 2, scope: { mode: 'folders', folderIds: ids } });
  await W.contactRequests(made.kit);
  W.makeReleasable();
  const started = await W.contactStarts(made.kit);
  assert.equal(started.status, 200, started.error?.message);
  const via = await W.throughRequireSession(started.json.sessionToken, { path: '/' });
  const ctx = (extra = {}) => ({ userId: via.req.userId, dek: via.req.dek, emergency: via.req.emergency, deviceId: null, ...extra });
  return { folders, docs, made, started, via, ctx, token: started.json.sessionToken };
}

const buildTaxes = (folders, docs) => {
  folders.taxes = W.addFolder('Taxes');
  folders.y24 = W.addFolder('Taxes/2024');
  folders.rec = W.addFolder('Taxes/2024/Receipts');
  folders.y23 = W.addFolder('Taxes/2023');
  docs.root = W.addDoc({ filename: 'root.txt' });
  docs.taxes = W.addDoc({ folder: 'Taxes', filename: 'taxes-top.txt' });
  docs.y24 = W.addDoc({ folder: 'Taxes/2024', filename: 'y24.txt' });
  docs.rec = W.addDoc({ folder: 'Taxes/2024/Receipts', filename: 'receipt.txt' });
  docs.y23 = W.addDoc({ folder: 'Taxes/2023', filename: 'y23.txt' });
};

test('the path helpers: aliases start at the scope folder, duplicates are told apart, nothing above is ever produced', () => {
  const emergency = { scopeMode: 'folders', scopePaths: ['Taxes/2024', 'Medical/Records', 'Legal/Records'] };
  assert.deepEqual(aliasesFor(emergency.scopePaths), [
    { path: 'Legal/Records', alias: 'Records' },
    { path: 'Medical/Records', alias: 'Records (2)' },
    { path: 'Taxes/2024', alias: '2024' },
  ]);
  assert.equal(toVirtual(emergency, 'Taxes/2024'), '2024');
  assert.equal(toVirtual(emergency, 'Taxes/2024/Receipts/Q1'), '2024/Receipts/Q1');
  assert.equal(toVirtual(emergency, 'Medical/Records/x'), 'Records (2)/x');
  assert.equal(toVirtual(emergency, 'Taxes'), null, 'a folder above the scope has no virtual path');
  assert.equal(toVirtual(emergency, 'Taxes/2023'), null);
  assert.equal(toReal(emergency, '2024/Receipts'), 'Taxes/2024/Receipts');
  assert.equal(toReal(emergency, 'records (2)'), 'Medical/Records', 'case-insensitive, like folder names');
  assert.equal(toReal(emergency, ''), '');
  assert.equal(toReal(emergency, 'Taxes'), null, 'the real parent name means nothing to a contact');
  assert.equal(toReal(emergency, 'Taxes/2024'), null);
  assert.deepEqual(scopeSummary(emergency), { mode: 'folders', folders: ['Records', 'Records (2)', '2024'] });
  assert.deepEqual(scopeSummary({ scopeMode: 'all' }), { mode: 'all', folders: [] });
  // a normal session is untouched
  assert.equal(toVirtual(null, 'Taxes/2024'), 'Taxes/2024');
  assert.equal(toReal(null, 'Taxes/2024'), 'Taxes/2024');
});

test('nested scope: no list, folder tree, breadcrumb path, direct access or error ever names a folder above the scope', async () => {
  const s = await nestedSession(['Taxes/2024'], buildTaxes);
  assert.deepEqual(s.started.json.scope, { mode: 'folders', folders: ['2024'] }, 'the start response names the scope folder only');

  const seen = [];
  const list = await call(D.listDocuments, s.ctx());
  seen.push(JSON.stringify(list.json));
  assert.deepEqual(list.json.map((d) => `${d.folder}/${d.filename}`).sort(), ['2024/Receipts/receipt.txt', '2024/y24.txt']);

  const folders = await call(D.listFolders, s.ctx());
  seen.push(JSON.stringify(folders.json));
  assert.deepEqual(folders.json, ['root', '2024', '2024/Receipts']);

  const top = await call(D.listFolderChildren, s.ctx({ query: { path: '' } }));
  seen.push(JSON.stringify(top.json));
  assert.deepEqual(top.json, { path: '', folders: [{ name: '2024', path: '2024', hasChildren: true }] });
  const inside = await call(D.listFolderChildren, s.ctx({ query: { path: '2024' } }));
  seen.push(JSON.stringify(inside.json));
  assert.deepEqual(inside.json, { path: '2024', folders: [{ name: 'Receipts', path: '2024/Receipts', hasChildren: false }] });
  const deep = await call(D.listFolderChildren, s.ctx({ query: { path: '2024/Receipts' } }));
  assert.equal(deep.json.path, '2024/Receipts', 'the breadcrumb path starts at the scope folder');
  seen.push(JSON.stringify(deep.json));

  // the real names are 404s, exactly like a folder that does not exist
  const missing = await call(D.listFolderChildren, s.ctx({ query: { path: 'Nope' } }));
  for (const real of ['Taxes', 'Taxes/2024', 'Taxes/2023', 'taxes', 'Taxes/2024/Receipts', '../Taxes']) {
    const out = await call(D.listFolderChildren, s.ctx({ query: { path: real } }));
    assert.equal(out.error?.status, 404, real);
    assert.equal(out.error.message, missing.error.message);
    seen.push(out.error.message);
  }

  // direct file access: in scope works (and sends no folder information), out of scope is the generic 404
  const ok = await call(D.viewDocument, s.ctx({ params: { id: String(s.docs.rec._id) }, query: {} }));
  assert.equal(ok.status, 200);
  seen.push(JSON.stringify(ok.headers));
  for (const doc of [s.docs.root, s.docs.taxes, s.docs.y23]) {
    const out = await call(D.viewDocument, s.ctx({ params: { id: String(doc._id) }, query: {} }));
    assert.equal(out.error?.status, 404);
    seen.push(out.error.message);
  }

  // "search" runs in the browser over exactly the lists above, so there is nothing else to leak
  const everything = seen.join('\n');
  assert.ok(!/Taxes/.test(everything), 'the name of the folder above the scope never appears');
  assert.ok(!/2023/.test(everything), 'nor a sibling');
  assert.ok(!everything.includes(OWNER_EMAIL));
});

test('two scoped folders that share a last name stay apart without revealing their parents', async () => {
  const s = await nestedSession(['Legal/Records', 'Medical/Records'], (folders, docs) => {
    folders.legal = W.addFolder('Legal');
    folders.lr = W.addFolder('Legal/Records');
    folders.med = W.addFolder('Medical');
    folders.mr = W.addFolder('Medical/Records');
    docs.l = W.addDoc({ folder: 'Legal/Records', filename: 'contract.txt' });
    docs.m = W.addDoc({ folder: 'Medical/Records', filename: 'scan.txt' });
    docs.o = W.addDoc({ folder: 'Legal', filename: 'above.txt' });
  });
  const top = await call(D.listFolderChildren, s.ctx({ query: { path: '' } }));
  assert.deepEqual(top.json.folders.map((f) => f.path).sort(), ['Records', 'Records (2)']);
  const list = await call(D.listDocuments, s.ctx());
  assert.deepEqual(list.json.map((d) => `${d.folder}/${d.filename}`).sort(), ['Records (2)/scan.txt', 'Records/contract.txt']);
  assert.ok(!/Legal|Medical/.test(JSON.stringify([top.json, list.json, s.started.json.scope])));
  // each alias opens its own folder
  const second = await call(D.listFolderChildren, s.ctx({ query: { path: 'Records (2)' } }));
  assert.equal(second.status, 200);
  assert.equal(second.json.path, 'Records (2)');
});

test('a whole-vault session shows real paths (there is nothing above the root to hide)', async () => {
  W.reset();
  const vault = W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 2 });
  await W.contactRequests(made.kit);
  W.makeReleasable();
  const started = await W.contactStarts(made.kit);
  const via = await W.throughRequireSession(started.json.sessionToken, { path: '/' });
  const list = await call(D.listDocuments, { userId: via.req.userId, dek: via.req.dek, emergency: via.req.emergency });
  assert.ok(list.json.some((d) => d.folder === 'Taxes/2024'));
  assert.ok(list.json.every((d) => d.shared === false), 'no sharing information for a contact');
  assert.ok(vault.docs.root);
});

test('session-info: read-only, when it ends and the top-level scope; never the owner; refused to a normal session', async () => {
  const s = await nestedSession(['Taxes/2024'], buildTaxes);
  const via = await W.throughRequireSession(s.token, { baseUrl: '/api/emergency', path: '/session-info' });
  assert.ok(via.reached, 'on the allowlist');
  const info = await call(E.sessionInfo, { userId: via.req.userId, emergency: via.req.emergency });
  assert.equal(info.status, 200);
  assert.deepEqual(Object.keys(info.json).sort(), ['expiresAt', 'readOnly', 'scopeSummary']);
  assert.equal(info.json.readOnly, true);
  assert.deepEqual(info.json.scopeSummary, { mode: 'folders', folders: ['2024'] });
  const row = world.tables.sessions.find((x) => x.emergency);
  assert.equal(new Date(info.json.expiresAt).getTime(), row.absoluteExpiresAt.getTime());
  const shown = JSON.stringify(info.json);
  assert.ok(!shown.includes(OWNER_EMAIL) && !/alice|Taxes\b/.test(shown), 'no owner name or address, no parent folder');

  // an ordinary session is not an emergency one
  const normal = await call(E.sessionInfo, W.owner());
  assert.equal(normal.error?.status, 404);
  // other emergency routes stay refused for the contact
  const status = await W.throughRequireSession(s.token, { baseUrl: '/api/emergency', path: '/status' });
  assert.equal(status.error?.status, 403);

  // a whole-vault session says so
  const all = await (async () => {
    W.reset();
    W.seedVault();
    const made = await W.setupEmergency({ waitMinutes: 2 });
    await W.contactRequests(made.kit);
    W.makeReleasable();
    const started = await W.contactStarts(made.kit);
    return W.throughRequireSession(started.json.sessionToken, { baseUrl: '/api/emergency', path: '/session-info' });
  })();
  const allInfo = await call(E.sessionInfo, { userId: all.req.userId, emergency: all.req.emergency });
  assert.deepEqual(allInfo.json.scopeSummary, { mode: 'all', folders: [] });
});

test('status carries the demo flag, the allowed waits and recent sessions for the owner screen', async () => {
  W.reset();
  W.seedVault();
  const prior = process.env.EMERGENCY_DEMO_MODE;
  try {
    process.env.EMERGENCY_DEMO_MODE = 'true';
    const before = await call(E.status, W.owner());
    assert.equal(before.json.configured, false);
    assert.equal(before.json.demoMode, true);
    assert.deepEqual(before.json.allowedWaits, [2, 4320, 10080, 20160]);

    const made = await W.setupEmergency({ waitMinutes: 2 });
    await W.contactRequests(made.kit);
    W.makeReleasable();
    await W.contactStarts(made.kit);
    const after = await call(E.status, W.owner());
    assert.equal(after.json.demoMode, true);
    assert.equal(after.json.recentSessions.last30Days, 1);
    assert.ok(after.json.recentSessions.lastStartedAt);
    assert.equal(after.json.activeSessions, 1);
    assert.equal(after.json.request.status, 'released');

    process.env.EMERGENCY_DEMO_MODE = 'false';
    const off = await call(E.status, W.owner());
    assert.equal(off.json.demoMode, false);
    assert.deepEqual(off.json.allowedWaits, [4320, 10080, 20160]);
  } finally {
    if (prior === undefined) delete process.env.EMERGENCY_DEMO_MODE;
    else process.env.EMERGENCY_DEMO_MODE = prior;
  }
});

test('the folder picker route lists the owner’s folders with ids, and is refused to an emergency session', async () => {
  W.reset();
  const vault = W.seedVault();
  const mine = await call(E.folderChoices, W.owner());
  assert.deepEqual(mine.json.folders.map((f) => f.path), ['Medical', 'Private', 'Taxes', 'Taxes/2024']);
  assert.equal(mine.json.folders[2].id, String(vault.folders.taxes._id));
  W.addFolder('Theirs', W.BOB);
  assert.equal((await call(E.folderChoices, W.owner())).json.folders.length, 4, 'only this account’s folders');
  const made = await W.setupEmergency({ waitMinutes: 2 });
  await W.contactRequests(made.kit);
  W.makeReleasable();
  const started = await W.contactStarts(made.kit);
  const refused = await W.throughRequireSession(started.json.sessionToken, { baseUrl: '/api/emergency', path: '/folders' });
  assert.equal(refused.error?.status, 403);
});

test('"Change contact or settings" replaces the setup with a fresh code: old kit dead, request cancelled, session ended, old contact told', async () => {
  W.reset();
  W.seedVault();
  const first = await W.setupEmergency({ waitMinutes: 2, contactEmail: 'old-contact@example.com' });
  await W.contactRequests(first.kit, {});
  // (the helper writes to the default contact; make a request for the old one directly)
  W.world.mails = [];
  const codes = require('../utils/emergency/codes');
  await codes.issueContactCode({ access: W.accessRow(), purpose: codes.PURPOSES.request, to: 'old-contact@example.com' });
  const code = W.codeFrom(W.mailsTo('old-contact@example.com').at(-1));
  const requested = await W.publicCall(E.request, { ownerEmail: OWNER_EMAIL, contactEmail: 'old-contact@example.com', code, kit: first.kit });
  assert.equal(requested.status, 201, requested.error?.message);
  const oldKit = require('../utils/emergency/kit').parseKit(first.kit);

  // without replace: still a 409; with replace: a new setup
  const refused = await W.ownerCode('setup');
  const body = { contactEmail: 'new-contact@example.com', contactLabel: 'New', waitMinutes: 4320, scope: { mode: 'all' } };
  assert.equal((await call(E.setup, W.owner({ body: { ...body, ...refused } }))).error?.status, 409);
  const fresh = await W.ownerCode('setup');
  const replaced = await call(E.setup, W.owner({ body: { ...body, replace: true, ...fresh } }));
  assert.equal(replaced.status, 201, replaced.error?.message);
  assert.equal(replaced.json.contactEmail, 'new-contact@example.com');
  assert.equal(replaced.json.kitVersion, 1);
  assert.equal(W.world.tables.emergencyaccesses.length, 1);
  assert.equal(require('../utils/emergency/kit').unwrapWithKit(W.accessRow(), oldKit), null, 'the old kit is useless');
  assert.equal(W.requestRows().filter((r) => r.active).length, 0, 'the open request was cancelled');
  assert.ok(W.mailsTo('old-contact@example.com').some((m) => /Emergency access was turned off/.test(m.subject)), 'the old contact was told');
  const types = W.world.tables.auditevents.map((e) => e.type);
  assert.ok(types.includes('emergency_revoked') && types.filter((t) => t === 'emergency_configured').length === 2);
});

test('the error handler passes the emergency codes the screens act on (and "not yet" carries the release time), and nothing else', () => {
  const { errorHandler } = require('../middleware/errorHandler');
  const answer = (error) => {
    const out = { status: null, body: null };
    const res = { statusCode: 200, status(code) { out.status = code; return this; }, json(body) { out.body = body; return this; }, setHeader() {} };
    errorHandler(error, { headers: {} }, res, () => {});
    return out;
  };
  const releaseAt = new Date('2026-10-12T01:00:00Z');
  const notYet = answer(Object.assign(new Error('The waiting period has not ended yet.'), { status: 409, code: 'NOT_YET', releaseAt }));
  assert.equal(notYet.status, 409);
  assert.equal(notYet.body.error.code, 'NOT_YET');
  assert.equal(new Date(notYet.body.error.releaseAt).getTime(), releaseAt.getTime());
  for (const code of ['EXPIRED', 'NO_REQUEST', 'NOT_AVAILABLE', 'EMERGENCY_READ_ONLY']) {
    assert.equal(answer(Object.assign(new Error('x'), { status: 403, code })).body.error.code, code);
  }
  // an internal code is still not forwarded, and releaseAt only rides on NOT_YET
  assert.equal(answer(Object.assign(new Error('x'), { status: 500, code: 'ENOENT' })).body.error.code, undefined);
  assert.equal(answer(Object.assign(new Error('x'), { status: 409, code: 'EXPIRED', releaseAt })).body.error.releaseAt, undefined);
});
