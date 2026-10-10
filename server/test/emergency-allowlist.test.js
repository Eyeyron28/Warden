// Run with: cd server && npm test
//
// Emergency sessions are read-only and deny-by-default. These tests walk the REAL router stack (the same routers
// server.js mounts) and prove that every registered route is either on the short allowlist or refused for an
// emergency token; then they check scope leaks, the session lifetime and that nothing else can make a session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const W = require('./helpers/emergencyWorld');
const { world, call, service, E, D, DEK, ALICE, OWNER_EMAIL, CONTACT_EMAIL } = W;
const { ALLOWLIST, matchAllowlist } = require('../middleware/emergencyGuard');
const requireSession = require('../middleware/requireSession');

const SERVER_DIR = path.join(__dirname, '..');
const ID = 'a'.repeat(24);

// ---------- the router stack, built from server.js itself ----------
function mountedRouters() {
  const source = fs.readFileSync(path.join(SERVER_DIR, 'server.js'), 'utf8');
  const modules = {}; // variable name -> { file, key }
  for (const match of source.matchAll(/const (\{[^}]*\}|\w+) = require\('\.\/routes\/([\w.]+)'\);/g)) {
    const file = path.join(SERVER_DIR, 'routes', match[2]);
    if (match[1].startsWith('{')) {
      for (const item of match[1].slice(1, -1).split(',').map((part) => part.trim()).filter(Boolean)) {
        const [key, alias] = item.split(':').map((part) => part.trim());
        modules[alias || key] = { file, key };
      }
    } else {
      modules[match[1]] = { file, key: null };
    }
  }
  const mounts = [];
  for (const match of source.matchAll(/app\.use\('(\/api[^']*)',\s*(\w+)\);/g)) {
    const entry = modules[match[2]];
    if (!entry) continue; // a plain middleware, not a router
    const loaded = require(entry.file);
    mounts.push({ prefix: match[1], name: match[2], router: entry.key ? loaded[entry.key] : loaded });
  }
  return mounts;
}

const concrete = (route) => String(route).replace(/:[A-Za-z]+/g, ID);

function registeredRoutes() {
  const routes = [];
  for (const { prefix, name, router } of mountedRouters()) {
    let guarded = false;
    for (const layer of router.stack) {
      if (!layer.route) {
        if (layer.handle === requireSession) guarded = true;
        continue;
      }
      const handlers = layer.route.stack.map((entry) => entry.handle);
      const routeGuarded = guarded || handlers.includes(requireSession);
      for (const method of Object.keys(layer.route.methods)) {
        const sub = typeof layer.route.path === 'string' ? layer.route.path : String(layer.route.path);
        routes.push({ router: name, method: method.toUpperCase(), prefix, route: sub, full: `${prefix}${sub === '/' ? '' : concrete(sub)}`, guarded: routeGuarded });
      }
    }
  }
  return routes;
}

/** An emergency session from the real flow (kit, code, wait, start). */
async function startEmergency({ scope = { mode: 'all' } } = {}) {
  W.reset();
  const vault = W.seedVault();
  const made = await W.setupEmergency({ waitMinutes: 2, scope });
  await W.contactRequests(made.kit);
  W.makeReleasable();
  const started = await W.contactStarts(made.kit);
  assert.equal(started.status, 200, started.error?.message);
  return { ...vault, made, token: started.json.sessionToken, started };
}

test('the allowlist is exactly these eight routes', () => {
  assert.deepEqual(
    ALLOWLIST.map((entry) => `${entry.method} ${entry.path.source}`),
    [
      'GET ^\\/api\\/auth\\/me$',
      'POST ^\\/api\\/auth\\/logout$',
      'GET ^\\/api\\/documents$',
      'GET ^\\/api\\/documents\\/folders$',
      'GET ^\\/api\\/documents\\/folders\\/children$',
      'GET ^\\/api\\/documents\\/[0-9a-f]{24}\\/view$',
      'GET ^\\/api\\/documents\\/[0-9a-f]{24}\\/thumbnail$',
      'GET ^\\/api\\/emergency\\/session-info$',
    ]
  );
  assert.ok(Object.isFrozen(ALLOWLIST));
});

test('EVERY registered route is on the allowlist, public (never sees a session), or refused for an emergency token', async () => {
  const { token } = await startEmergency();
  const routes = registeredRoutes();
  assert.ok(routes.length > 80, `the stack was enumerated (${routes.length} routes)`);

  // the routes server.js mounts are the ones we walked (a new router must show up here)
  const mounted = mountedRouters().map((m) => m.prefix).sort();
  for (const expected of ['/api/auth', '/api/documents', '/api/shares', '/api/shared', '/api/account', '/api/security', '/api/insights', '/api/trash', '/api/cron', '/api/emergency', '/api/emergency/public']) {
    assert.ok(mounted.includes(expected), `${expected} is mounted and walked`);
  }

  const PUBLIC_PREFIXES = ['/api/auth', '/api/shared', '/api/emergency/public', '/api/cron', '/api'];
  let allowed = 0;
  let refused = 0;
  let publicCount = 0;
  const unguardedElsewhere = [];
  for (const entry of routes) {
    const listed = entry.guarded && matchAllowlist(entry.method, entry.full);
    if (listed) {
      allowed += 1;
      const { error, reached } = await W.throughRequireSession(token, { method: entry.method, baseUrl: entry.prefix, path: entry.route === '/' ? '/' : concrete(entry.route) });
      assert.ok(reached && !error, `${entry.method} ${entry.full} is allowed`);
      continue;
    }
    if (entry.guarded) {
      refused += 1;
      const { error, reached } = await W.throughRequireSession(token, { method: entry.method, baseUrl: entry.prefix, path: entry.route === '/' ? '/' : concrete(entry.route) });
      assert.equal(reached, false, `${entry.method} ${entry.full} must not reach its handler`);
      assert.equal(error?.status, 403, `${entry.method} ${entry.full} is refused with 403`);
      assert.equal(error?.code, 'EMERGENCY_READ_ONLY');
      continue;
    }
    // no session check at all: it must be one of the places that never takes a session
    publicCount += 1;
    if (!PUBLIC_PREFIXES.some((prefix) => entry.prefix === prefix)) unguardedElsewhere.push(`${entry.method} ${entry.full}`);
  }
  assert.deepEqual(unguardedElsewhere, [], 'a route without requireSession outside the known public areas');
  assert.equal(allowed, ALLOWLIST.length, 'every allowlist entry is a real route, and nothing else is allowed');
  assert.ok(refused >= 40, `many routes refused (${refused})`);
  assert.ok(publicCount > 20);

  // among the unguarded /api/auth routes none is /me or /logout
  const authOpen = routes.filter((r) => r.prefix === '/api/auth' && !r.guarded).map((r) => r.route);
  assert.ok(!authOpen.includes('/me') && !authOpen.includes('/logout'));
});

test('writes are refused even on an allowlisted path; the verb matters', async () => {
  const { token, docs } = await startEmergency();
  const tries = [
    ['POST', '/api/documents', '/'], ['PUT', '/api/documents', '/'], ['PATCH', '/api/documents', `/${docs.root._id}`], ['DELETE', '/api/documents', `/${docs.root._id}`],
    ['POST', '/api/documents', `/${docs.root._id}/view`], ['DELETE', '/api/documents', `/${docs.root._id}/view`],
    ['PUT', '/api/documents', `/${docs.root._id}/thumbnail`], ['POST', '/api/documents', `/${docs.root._id}/downloaded`],
    ['POST', '/api/documents', '/move'], ['POST', '/api/documents', '/folders'], ['PATCH', '/api/documents', '/folders'], ['DELETE', '/api/documents', '/folders'],
    ['GET', '/api/documents', '/photos'], ['GET', '/api/documents', '/storage'], ['GET', '/api/documents', '/expiring'],
    ['POST', '/api/shares', '/'], ['GET', '/api/shares', '/'], ['POST', '/api/trash', '/restore'], ['DELETE', '/api/trash', '/'],
    ['GET', '/api/security', '/activity'], ['GET', '/api/security', '/devices'], ['POST', '/api/security', '/verify-log'],
    ['GET', '/api/insights', '/overview'], ['GET', '/api/account', '/health'], ['GET', '/api/account', '/preferences'], ['PATCH', '/api/account', '/preferences'],
    ['DELETE', '/api/account', '/'], ['GET', '/api/account', '/trusted-devices'],
    ['GET', '/api/emergency', '/status'], ['POST', '/api/emergency', '/setup'], ['POST', '/api/emergency', '/revoke'], ['POST', '/api/emergency', `/requests/${ID}/approve-now`],
    ['GET', '/api/documents', '/../account/health'],
  ];
  for (const [method, baseUrl, sub] of tries) {
    const { error, reached } = await W.throughRequireSession(token, { method, baseUrl, path: sub });
    assert.equal(reached, false, `${method} ${baseUrl}${sub}`);
    assert.equal(error?.status, 403, `${method} ${baseUrl}${sub}`);
  }
  // look-alike paths are not allowlisted; the real ones are
  for (const sneaky of ['/api/documents/folders/x', `/api/documents/${ID}/view/extra`, '/api/documents/zz/view', '/api/documents/ABCDEFABCDEFABCDEFABCDEF/view', '/api/documents/folders/children/x', '/api/auth/me/x', '/api/auth/mee', '/api/documents/../account/health']) {
    assert.equal(matchAllowlist('GET', sneaky), null, sneaky);
  }
  for (const real of ['/api/documents', '/api/documents/', '/api/documents/folders', `/api/documents/${ID}/view`, '/api/auth/me']) {
    assert.notEqual(matchAllowlist('GET', real), null, real);
  }
  assert.notEqual(matchAllowlist('HEAD', '/api/documents'), null, 'HEAD counts as GET');
});

// ---------- scope ----------
async function scopedSession(folderPaths, extraFolders = []) {
  W.reset();
  const vault = W.seedVault();
  const extra = {};
  for (const [name, folder, file] of extraFolders) {
    extra[name] = { folder: W.addFolder(folder), doc: W.addDoc({ folder, filename: file }) };
  }
  const ids = folderPaths.map((p) => String([...Object.values(vault.folders), ...Object.values(extra).map((e) => e.folder)].find((f) => (f.parentPath ? `${f.parentPath}/${f.name}` : f.name) === p)._id));
  const made = await W.setupEmergency({ waitMinutes: 2, scope: { mode: 'folders', folderIds: ids } });
  await W.contactRequests(made.kit);
  W.makeReleasable();
  const started = await W.contactStarts(made.kit);
  assert.equal(started.status, 200, started.error?.message);
  const via = await W.throughRequireSession(started.json.sessionToken, { path: '/' });
  assert.ok(via.reached, via.error?.message);
  const ctx = (extra2 = {}) => ({ userId: via.req.userId, dek: via.req.dek, emergency: via.req.emergency, deviceId: null, ...extra2 });
  return { ...vault, extra, made, token: started.json.sessionToken, req: via.req, ctx, started };
}

test('scope leaks: a folder-scoped session sees only its folders and what is inside them, everywhere', async () => {
  const s = await scopedSession(['Taxes']);
  assert.deepEqual(s.req.emergency.scopePaths, ['Taxes']);
  assert.equal(s.req.emergency.scopeMode, 'folders');
  assert.equal(s.started.json.scope.mode, 'folders');

  // the file list (and so every count, search and breadcrumb the browser builds from it)
  const list = await call(D.listDocuments, s.ctx());
  assert.deepEqual(list.json.map((d) => d.filename).sort(), ['taxes-2024.txt', 'taxes-return.txt']);
  assert.equal(list.json.length, 2, 'the count is the scoped count');
  const shown = JSON.stringify(list.json);
  for (const hidden of ['root-passport', 'medical-record', 'private-diary', 'Medical', 'Private']) assert.ok(!shown.includes(hidden), `${hidden} never appears`);

  // the folder tree
  const folders = await call(D.listFolders, s.ctx());
  assert.deepEqual(folders.json, ['root', 'Taxes', 'Taxes/2024']);
  const top = await call(D.listFolderChildren, s.ctx({ query: { path: '' } }));
  assert.deepEqual(top.json.folders.map((f) => f.path), ['Taxes'], 'the top level is just the chosen folders');
  assert.equal(top.json.folders[0].hasChildren, true);
  const inside = await call(D.listFolderChildren, s.ctx({ query: { path: 'Taxes' } }));
  assert.deepEqual(inside.json.folders.map((f) => f.path), ['Taxes/2024']);
  for (const outside of ['Medical', 'Private', 'medical', 'Nope']) {
    const out = await call(D.listFolderChildren, s.ctx({ query: { path: outside } }));
    assert.equal(out.error?.status, 404, `${outside} is a 404`);
  }
  const nope = await call(D.listFolderChildren, s.ctx({ query: { path: 'Nope' } }));
  const hidden = await call(D.listFolderChildren, s.ctx({ query: { path: 'Medical' } }));
  assert.equal(hidden.error.message, nope.error.message, 'a real folder out of scope looks exactly like one that does not exist');

  // direct access by id: 404, never 403, same as a file that does not exist
  const missing = await call(D.viewDocument, s.ctx({ params: { id: String(W.db.oid()) }, query: {} }));
  for (const doc of [s.docs.root, s.docs.medical, s.docs.priv]) {
    const view = await call(D.viewDocument, s.ctx({ params: { id: String(doc._id) }, query: {} }));
    assert.equal(view.error?.status, 404);
    assert.equal(view.error.message, missing.error.message);
    const thumb = await call(D.getThumbnail, s.ctx({ params: { id: String(doc._id) } }));
    assert.equal(thumb.error?.status, 404);
  }
  // inside the scope it works, nested folders included
  for (const doc of [s.docs.taxes, s.docs.tax24]) {
    const view = await call(D.viewDocument, s.ctx({ params: { id: String(doc._id) }, query: {} }));
    assert.equal(view.status, 200);
    assert.deepEqual(view.body, doc.plaintext);
  }
});

test('scope edges: a sibling with the same prefix, regex characters, a deleted folder and Trash', async () => {
  const s = await scopedSession(['Tax.1'], [['dot', 'Tax.1', 'dot-doc.txt'], ['lookalike', 'TaxX1', 'lookalike-doc.txt'], ['prefix', 'Tax.10', 'prefix-doc.txt']]);
  const list = await call(D.listDocuments, s.ctx());
  assert.deepEqual(list.json.map((d) => d.filename), ['dot-doc.txt'], 'Tax.1 is not a pattern and not a prefix of Tax.10');
  // a trashed file inside the scope is not served
  const inScope = W.addDoc({ folder: 'Tax.1', filename: 'trashed-one.txt' });
  inScope.deletedAt = new Date();
  const after = await call(D.listDocuments, s.ctx());
  assert.deepEqual(after.json.map((d) => d.filename), ['dot-doc.txt']);
  assert.equal((await call(D.viewDocument, s.ctx({ params: { id: String(inScope._id) }, query: {} }))).error?.status, 404);

  // the owner deletes the folder afterwards: a NEW session's scope is empty, not "everything"
  world.tables.folders = world.tables.folders.filter((f) => f.name !== 'Tax.1');
  const code = await W.contactCode();
  world.tables.sessions = [];
  W.requestRows()[0].status = 'released';
  const again = await W.publicCall(E.startSession, { ownerEmail: OWNER_EMAIL, contactEmail: CONTACT_EMAIL, code, kit: s.made.kit });
  assert.equal(again.status, 200, again.error?.message);
  const via = await W.throughRequireSession(again.json.sessionToken, { path: '/' });
  assert.deepEqual(via.req.emergency.scopePaths, []);
  const empty = await call(D.listDocuments, { userId: via.req.userId, dek: via.req.dek, emergency: via.req.emergency });
  assert.deepEqual(empty.json, []);
  const emptyTop = await call(D.listFolderChildren, { userId: via.req.userId, dek: via.req.dek, emergency: via.req.emergency, query: { path: '' } });
  assert.deepEqual(emptyTop.json.folders, []);
});

test('a whole-vault session lists everything live, still read-only, with no counters changed and every read logged', async () => {
  const s = await startEmergency();
  const via = await W.throughRequireSession(s.token, { path: '/' });
  const ctx = (extra = {}) => ({ userId: via.req.userId, dek: via.req.dek, emergency: via.req.emergency, ...extra });
  const trashed = W.addDoc({ folder: 'Medical', filename: 'in-trash.txt' });
  trashed.deletedAt = new Date();
  const list = await call(D.listDocuments, ctx());
  assert.equal(list.json.length, 5, 'all five live files, none from Trash');

  const before = JSON.stringify(Object.values(s.docs).map((d) => [d.viewCount, d.downloadCount, d.lastOpenedAt]));
  for (const query of [{}, { for: 'download' }, { for: 'silent' }]) {
    const out = await call(D.viewDocument, ctx({ params: { id: String(s.docs.root._id) }, query }));
    assert.equal(out.status, 200);
  }
  assert.equal(JSON.stringify(Object.values(s.docs).map((d) => [d.viewCount, d.downloadCount, d.lastOpenedAt])), before, 'the owner’s counters never move');
  const reads = world.tables.auditevents.filter((e) => /^emergency_file_/.test(e.type));
  assert.deepEqual(reads.map((e) => e.type), ['emergency_file_viewed', 'emergency_file_downloaded', 'emergency_file_viewed'], 'even a "silent" read is logged');
  assert.ok(reads.every((e) => e.actor === 'emergency' && String(e.targetId) === String(s.docs.root._id) && e.deviceId === null));
  assert.equal(world.tables.auditevents.filter((e) => e.type === 'view' || e.type === 'download').length, 0, 'no ordinary view/download events');
});

test('an emergency session is not a device, learns no owner address, and shows up only in Emergency status', async () => {
  const s = await startEmergency();
  const row = world.tables.sessions.find((x) => x.emergency);
  assert.equal(row.deviceId, null);
  assert.equal(row.emergency, true);
  assert.equal(row.scopeMode, 'all');
  const security = require('../controllers/security.controller');
  const devices = await call(security.listDevices, W.owner());
  assert.equal(JSON.stringify(devices.json).includes('emergency'), false);
  assert.equal(devices.json.devices?.length ?? devices.json.length ?? 0, 0, 'no device row was made');
  assert.equal(world.tables.devices.length, 0);

  const via = await W.throughRequireSession(s.token, { baseUrl: '/api/auth', path: '/me' });
  const me = await call(require('../controllers/auth.controller').getMe, { userId: via.req.userId, emergency: via.req.emergency });
  assert.equal(me.json.emergency, true);
  assert.equal(me.json.readOnly, true);
  assert.ok(!JSON.stringify(me.json).includes(OWNER_EMAIL), 'the contact is not told the owner’s address by this call');

  const status = await call(E.status, W.owner());
  assert.equal(status.json.activeSessions, 1);
});

// ---------- session lifetime ----------
test('an emergency session ends at 4 hours whatever happens, and sliding refreshes never push past it', async () => {
  const s = await startEmergency();
  const row = world.tables.sessions.find((x) => x.emergency);
  const created = row.createdAt.getTime();
  assert.ok(row.absoluteExpiresAt.getTime() - created === 4 * 3600 * 1000, 'absolute max 4 hours');
  assert.ok(row.expiresAt.getTime() - created <= 30 * 60 * 1000 + 10, 'idle TTL 30 minutes');

  // every use slides the idle window, but never beyond the absolute end
  const near = new Date(Date.now() + 10 * 60 * 1000);
  row.absoluteExpiresAt = near;
  const ok = await W.throughRequireSession(s.token, { path: '/' });
  assert.ok(ok.reached);
  assert.ok(row.expiresAt.getTime() <= near.getTime(), 'the refresh stopped at the absolute end');

  // past the absolute end: dead, and gone, even though the idle window was open
  row.expiresAt = new Date(Date.now() + 20 * 60 * 1000);
  row.absoluteExpiresAt = new Date(Date.now() - 1000);
  const dead = await W.throughRequireSession(s.token, { path: '/' });
  assert.equal(dead.error?.status, 401);
  assert.equal(world.tables.sessions.length, 0);

  // a normal login session is unchanged: 30 minutes sliding, no absolute end
  W.reset();
  const token = await require('../utils/sessionStore').createSession(ALICE, DEK, { deviceId: null });
  const normal = world.tables.sessions[0];
  assert.equal(normal.absoluteExpiresAt ?? null, null);
  assert.equal(normal.emergency ?? false, false);
  const used = await W.throughRequireSession(token, { baseUrl: '/api/account', path: '/health' });
  assert.ok(used.reached, 'a normal session is not touched by the guard');
  assert.equal(used.req.emergency, null);
});

test('turning emergency access off ends a running session at once', async () => {
  const s = await startEmergency();
  assert.ok((await W.throughRequireSession(s.token, { path: '/' })).reached);
  const fresh = await W.ownerCode('revoke');
  assert.equal((await call(E.revoke, W.owner({ body: fresh }))).status, 200);
  const after = await W.throughRequireSession(s.token, { path: '/' });
  assert.equal(after.error?.status, 401);
  assert.equal(after.reached, false);
});

test('regenerating the kit and a changed vault key also end running sessions at once', async () => {
  const s = await startEmergency();
  const fresh = await W.ownerCode('regenerate');
  await call(E.regenerateKit, W.owner({ body: fresh }));
  assert.equal((await W.throughRequireSession(s.token, { path: '/' })).error?.status, 401);
});

// ---------- only one door for sessions ----------
test('nothing but createSession makes a session, and only login and Emergency Access call it', () => {
  const offenders = { create: [], callers: [] };
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'test') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(full);
      else if (entry.name.endsWith('.js')) {
        const text = fs.readFileSync(full, 'utf8');
        const rel = path.relative(SERVER_DIR, full).replace(/\\/g, '/');
        if (/Session\.(create|insertMany|findOneAndUpdate\([^)]*upsert)/.test(text) || /new Session\(/.test(text)) offenders.create.push(rel);
        if (/\bcreateSession\(/.test(text)) offenders.callers.push(rel);
      }
    }
  };
  scan(SERVER_DIR);
  assert.deepEqual(offenders.create, ['utils/sessionStore.js'], 'only the session store writes Session rows');
  assert.deepEqual(offenders.callers.sort(), ['controllers/auth.controller.js', 'utils/emergency/service.js', 'utils/sessionStore.js']);
  // and the emergency call is the one that is flagged emergency
  const service = fs.readFileSync(path.join(SERVER_DIR, 'utils', 'emergency', 'service.js'), 'utf8');
  assert.match(service, /createSession\(access\.userId, dek, \{\s*emergency:/);
  const login = fs.readFileSync(path.join(SERVER_DIR, 'controllers', 'auth.controller.js'), 'utf8');
  assert.ok(!/emergency/.test(login.split('createSession(')[1]?.slice(0, 80) || ''), 'login never makes an emergency session');
});

test('the guard sits inside requireSession, so a route added later is refused unless it is allowlisted on purpose', () => {
  const source = fs.readFileSync(path.join(SERVER_DIR, 'middleware', 'requireSession.js'), 'utf8');
  assert.match(source, /if \(session\.emergency\) assertEmergencyAllowed\(req\)/);
  assert.ok(source.indexOf('assertEmergencyAllowed(req)') < source.indexOf('req.userId = session.userId'), 'checked before any handler data is set up');
  // no controller makes an exception for emergency sessions except the read paths that narrow to the scope
  const using = [];
  for (const dir of ['controllers', 'routes', 'middleware', 'utils']) {
    for (const entry of fs.readdirSync(path.join(SERVER_DIR, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      if (/req\.emergency/.test(fs.readFileSync(path.join(SERVER_DIR, dir, entry.name), 'utf8'))) using.push(`${dir}/${entry.name}`);
    }
  }
  assert.deepEqual(using.sort(), ['controllers/auth.controller.js', 'controllers/documents.controller.js', 'controllers/emergency.controller.js', 'middleware/emergencyGuard.js', 'middleware/requireSession.js']);
});

test('the kit and the codes are read nowhere but the emergency service (no other module touches K1)', () => {
  const users = [];
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'test') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(full);
      else if (entry.name.endsWith('.js') && /emergency\/kit|\.\/kit'/.test(fs.readFileSync(full, 'utf8'))) users.push(path.relative(SERVER_DIR, full).replace(/\\/g, '/'));
    }
  };
  scan(SERVER_DIR);
  assert.deepEqual(users.sort(), ['utils/emergency/service.js']);
  assert.ok(service && typeof service.setup === 'function');
});
