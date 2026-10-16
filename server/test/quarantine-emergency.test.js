// Run with: cd server && npm test
//
// Emergency Access and Quarantine: a read-only emergency session never lists or reads a file held in Quarantine (whole-vault or
// folder-scoped), cannot see the Quarantine list or release anything, and the allowlist is unchanged. In-memory world, no database.
const test = require('node:test');
const assert = require('node:assert/strict');

const W = require('./helpers/emergencyWorld');
const { call, D } = W;
const { documentScope } = require('../utils/emergency/scope');
const { ALLOWLIST, matchAllowlist } = require('../middleware/emergencyGuard');

async function session(scope) {
  W.reset();
  const vault = W.seedVault();
  const folderIds = scope?.mode === 'folders' ? scope.names.map((n) => String(Object.values(vault.folders).find((f) => f.name === n)._id)) : undefined;
  const made = await W.setupEmergency({ waitMinutes: 2, scope: scope?.mode === 'folders' ? { mode: 'folders', folderIds } : { mode: 'all' } });
  await W.contactRequests(made.kit);
  W.makeReleasable();
  const started = await W.contactStarts(made.kit);
  assert.equal(started.status, 200, started.error?.message);
  const via = await W.throughRequireSession(started.json.sessionToken, { path: '/' });
  const ctx = (extra = {}) => ({ userId: via.req.userId, dek: via.req.dek, emergency: via.req.emergency, deviceId: null, ...extra });
  return { vault, via, ctx, token: started.json.sessionToken };
}

const hold = (doc) => {
  doc.quarantine = { state: 'held', heldAt: new Date() };
  doc.scan = { verdict: 'suspicious', reasons: ['PDF_ACTIVE'], scannerVersion: 1, scannedAt: new Date() };
};

test('a whole-vault emergency session never lists, previews or thumbnails a held file; the owner\'s own list is the only way to see it exists', async () => {
  const { vault, ctx } = await session();
  hold(vault.docs.medical);
  const list = await call(D.listDocuments, ctx());
  const names = list.json.map((d) => d.filename);
  assert.ok(names.includes('root-passport.txt'));
  assert.ok(!names.includes('medical-record.txt'), 'held: not listed');
  const view = await call(D.viewDocument, ctx({ params: { id: String(vault.docs.medical._id) } }));
  assert.equal(view.error?.status, 404, 'the same 404 as a file that is not there (it does not say it is held)');
  assert.equal(view.error?.code, undefined);
  const ok = await call(D.viewDocument, ctx({ params: { id: String(vault.docs.root._id) } }));
  assert.equal(ok.error, null);
  const thumb = await call(D.getThumbnail, ctx({ params: { id: String(vault.docs.medical._id) } }));
  assert.equal(thumb.error?.status, 404);
});

test('a folder-scoped emergency session leaves held files out too, inside its scope', async () => {
  const { vault, ctx } = await session({ mode: 'folders', names: ['Taxes'] });
  hold(vault.docs.taxes);
  const names = (await call(D.listDocuments, ctx())).json.map((d) => d.filename);
  assert.ok(names.includes('taxes-2024.txt'));
  assert.ok(!names.includes('taxes-return.txt'));
  assert.equal((await call(D.viewDocument, ctx({ params: { id: String(vault.docs.taxes._id) } }))).error?.status, 404);
});

test('the filter every emergency read uses carries the held rule, and a normal session\'s scope is unchanged', () => {
  assert.deepEqual(documentScope(null), {});
  assert.deepEqual(documentScope({ scopeMode: 'all' }), { 'quarantine.state': { $ne: 'held' } });
  const scoped = documentScope({ scopeMode: 'folders', scopePaths: ['Taxes'] });
  assert.deepEqual(scoped['quarantine.state'], { $ne: 'held' });
  assert.ok(Array.isArray(scoped.$or));
});

test('an emergency session cannot list Quarantine or release a file: 403 read-only, and the allowlist is still the same eight routes', async () => {
  const { token } = await session();
  for (const [method, baseUrl, path] of [
    ['GET', '/api/quarantine', '/'],
    ['POST', '/api/documents', `/${'a'.repeat(24)}/quarantine/release`],
  ]) {
    const out = await W.throughRequireSession(token, { method, baseUrl, path });
    assert.equal(out.error?.status, 403, `${method} ${baseUrl}${path}`);
    assert.equal(out.error?.code, 'EMERGENCY_READ_ONLY');
    assert.equal(out.reached, false);
  }
  assert.equal(ALLOWLIST.length, 8);
  assert.equal(matchAllowlist('GET', '/api/quarantine'), null);
  assert.equal(matchAllowlist('POST', `/api/documents/${'a'.repeat(24)}/quarantine/release`), null);
});
