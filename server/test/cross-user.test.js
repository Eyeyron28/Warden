// Run with: cd server && npm test
//
// CROSS-USER AUTHORIZATION, route by route, against the REAL app (test/helpers/liveApp.js: every middleware and router,
// real HTTP, a LOCAL throwaway MongoDB, mail captured, no .env read). Skipped, with the reason, when no local MongoDB answers.
//
// Two accounts are made through the API. A owns documents (live, in a folder, trashed), a folder, a trashed folder, shares,
// a device, a trusted browser, a delete-account challenge, reminders, activity events and an Emergency Access setup with an
// open request. Then, signed in as B only, EVERY owner route is called with A's identifiers (in the path, the query and
// the body). The router stack is walked to find the routes, so a route added later without a plan below FAILS this test.
//
// What is asserted:
//   - the set of routes that need no session is exactly the known public set (a new unguarded route fails);
//   - every owner route has a plan, and no plan is left unused;
//   - a request that names one of A's objects is answered 403/404 (or the one documented denial for that route) and carries
//     no data of A's;
//   - a route with nothing to name (a list, a settings page) answers B's own data and none of A's;
//   - after all of it, A's rows (documents, folders, trash, shares, devices, sessions, activity, emergency data, reminders)
//     are byte-for-byte what they were, and A can still use everything.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { startLiveApp } = require('./helpers/liveApp');

const PASSWORD = 'Qx7!vTr29#mLpw';
const A_EMAIL = 'a.owner@example.com';
const B_EMAIL = 'b.owner@example.com';
const A_CONTACT = 'a.contact@example.com';
const A_FOLDER = 'A-Private-Folder';
const A_TRASHED_FOLDER = 'A-Trashed-Folder';
// A folder only A ever names: if it shows up in an answer to B, B was shown A's folders. (A_FOLDER is a name B also types in its
// requests - folders are per-account, so B naming it makes B's OWN folder of that name; what matters is that A's is untouched.)
const A_HIDDEN = 'A-Hidden-Folder-ZQX';

// ---------- the routes that need no session (everything else must be owner-scoped) ----------
const REMOVED = ['/api/backup', '/api/backup/*', '/api/auth/recover-via-usb', '/api/pair', '/api/pair/*', '/api/pairing', '/api/pairing/*', '/api/sync', '/api/sync/*', '/api/devices', '/api/devices/*', '/api/auth/recover-via-phone', '/api/auth/recover-via-phone/*'].map((p) => `ALL ${p}`);
const PUBLIC_ROUTES = new Set([
  ...REMOVED,
  'GET /api/health',
  'POST /api/auth/signup', 'POST /api/auth/verify-email', 'POST /api/auth/resend-verification', 'GET /api/auth/config', 'POST /api/auth/unlock',
  'POST /api/auth/verify-otp', 'POST /api/auth/resend-otp',
  'POST /api/auth/password-reset/start', 'POST /api/auth/password-reset/resend', 'POST /api/auth/password-reset/verify',
  'POST /api/auth/password-reset/with-recovery-key', 'POST /api/auth/password-reset/start-over', 'POST /api/auth/password-reset/recovery-key-only',
  'POST /api/auth/forgot-password', 'POST /api/auth/reset-password',
  'POST /api/shared/:shareId/access', 'POST /api/shared/:shareId/email-code', 'POST /api/shared/:shareId/email-verify', 'POST /api/shared/:shareId/unlock',
  'GET /api/shared/:shareId', 'GET /api/shared/:shareId/files/:fileId',
  'POST /api/emergency/public/request-code', 'POST /api/emergency/public/request', 'POST /api/emergency/public/start-session', 'GET /api/emergency/public/deny/:token',
  'GET /api/cron/purge-trash', 'GET /api/cron/reminders',
]);

/** Every route of the real app with whether a session is required, found by walking the router stack. */
function enumerateRoutes(app) {
  const requireSession = require('../middleware/requireSession');
  const out = [];
  const mountOf = (layer) => {
    const match = /^\^(.*?)\\\/\?\(\?=\\\/\|\$\)$/.exec(layer.regexp.source);
    return match ? match[1].replace(/\\\//g, '/') : '';
  };
  const walk = (stack, prefix, inheritedGuard) => {
    let guarded = inheritedGuard;
    for (const layer of stack) {
      if (layer.route) {
        const handlers = layer.route.stack.map((entry) => entry.handle);
        const routeGuarded = guarded || handlers.includes(requireSession);
        for (const method of Object.keys(layer.route.methods)) {
          const path = prefix + (layer.route.path === '/' ? '' : layer.route.path);
          out.push({ method: method === '_all' ? 'ALL' : method.toUpperCase(), path, guarded: routeGuarded });
        }
      } else if (layer.name === 'router') {
        walk(layer.handle.stack, prefix + mountOf(layer), guarded);
      } else if (layer.handle === requireSession) {
        guarded = true;
      }
    }
  };
  walk(app._router.stack, '', false);
  return out;
}

let live = { ok: false, reason: '' };
test.before(async () => {
  live = await startLiveApp('cross_user');
});
test.after(async () => {
  if (live.ok) await live.stop();
});

const it = (name, fn) =>
  test(name, async (context) => {
    if (!live.ok) return context.skip(live.reason);
    return fn(context);
  });

// ---------- the world ----------
const world = {};

const codeFromMail = (mail) => /(?<![\d-])(\d{6})(?![\d-])/.exec(mail.text)[1];
const lastMailTo = (address) => live.mails.filter((mail) => mail.to === address).at(-1);

async function signUpAndIn(email) {
  const { api, mongoose } = live;
  const signup = await api('POST', '/api/auth/signup', { json: { email, password: PASSWORD } });
  assert.equal(signup.status, 200, signup.text);
  await mongoose.models.User.updateOne({ email }, { $set: { emailVerified: true } });
  const login = await api('POST', '/api/auth/unlock', { json: { email, password: PASSWORD } });
  assert.equal(login.status, 200, login.text);
  const user = await mongoose.models.User.findOne({ email }).lean();
  return { token: login.body.sessionToken, userId: String(user._id), email };
}

function textFile(name, content, folder) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), name);
  if (folder) form.append('folder', folder);
  return form;
}

async function buildWorld() {
  const { api, mongoose } = live;
  const M = mongoose.models;
  const A = await signUpAndIn(A_EMAIL);
  const B = await signUpAndIn(B_EMAIL);
  world.A = A;
  world.B = B;

  // A: a folder with a shared document in it, a document with an expiry date, a trashed document, a trashed folder
  assert.equal((await api('POST', '/api/documents/folders', { token: A.token, json: { name: A_FOLDER, parentPath: '' } })).status, 201);
  const doc1 = await api('POST', '/api/documents', { token: A.token, form: textFile('A-secret-1.txt', 'A secret one', A_FOLDER) });
  const doc2 = await api('POST', '/api/documents', { token: A.token, form: textFile('A-secret-2.txt', 'A secret two') });
  const doc3 = await api('POST', '/api/documents', { token: A.token, form: textFile('A-secret-3.txt', 'A secret three') });
  for (const doc of [doc1, doc2, doc3]) assert.equal(doc.status, 201, doc.text);
  world.docId = doc1.body.id;
  world.docId2 = doc2.body.id;
  world.trashedDocId = doc3.body.id;
  const soon = new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10);
  assert.equal((await api('PATCH', `/api/documents/${world.docId2}`, { token: A.token, json: { expiryDate: soon } })).status, 200);
  assert.equal((await api('DELETE', `/api/documents/${world.trashedDocId}`, { token: A.token })).status, 204);
  assert.equal((await api('POST', '/api/documents/folders', { token: A.token, json: { name: A_HIDDEN, parentPath: '' } })).status, 201);
  assert.equal((await api('POST', '/api/documents', { token: A.token, form: textFile('A-secret-hidden.txt', 'hidden', A_HIDDEN) })).status, 201);
  assert.equal((await api('POST', '/api/documents/folders', { token: A.token, json: { name: A_TRASHED_FOLDER, parentPath: '' } })).status, 201);
  assert.equal((await api('POST', '/api/documents', { token: A.token, form: textFile('A-in-trashed-folder.txt', 'x', A_TRASHED_FOLDER) })).status, 201);
  assert.equal((await api('DELETE', '/api/documents/folders', { token: A.token, query: { path: A_TRASHED_FOLDER } })).status, 204);
  const trash = await api('GET', '/api/trash', { token: A.token });
  world.trashedFolderId = trash.body.items.find((item) => item.kind === 'folder').id;

  // A: two shares (one limited), a device, a trusted browser, reminders
  const share1 = await api('POST', `/api/documents/${world.docId}/share`, { token: A.token, json: { durationHours: 24 } });
  assert.equal(share1.status, 201, share1.text);
  world.shareId = share1.body.id;
  world.shareKey = share1.body.shareUrl.split('#k=')[1];
  const share2 = await api('POST', `/api/documents/${world.docId2}/share`, { token: A.token, json: { durationHours: 24, maxDownloads: 3 } });
  assert.equal(share2.status, 201, share2.text);
  world.shareId2 = share2.body.id;
  const devices = await api('GET', '/api/security/devices', { token: A.token });
  world.deviceId = devices.body.devices[0].id;
  const trusted = await M.TrustedDevice.create({
    userId: A.userId, tokenHash: crypto.randomBytes(32).toString('hex'), label: 'A-trusted-browser', deviceId: world.deviceId, expiresAt: new Date(Date.now() + 864e5),
  });
  world.trustedId = String(trusted._id);
  await M.ReminderLog.create({ userId: A.userId, fileId: world.docId2, threshold: 7, sent: true });
  world.folderRowId = String((await M.Folder.findOne({ userId: A.userId, name: A_FOLDER }).lean())._id);

  // A: challenges (delete account, and an Emergency Access action) held by A only
  const del = await api('POST', '/api/account/delete-challenge', { token: A.token, json: { password: PASSWORD } });
  assert.equal(del.status, 200, del.text);
  world.deleteToken = del.body.challengeToken;
  const revokeChallenge = await api('POST', '/api/emergency/challenge', { token: A.token, json: { action: 'revoke' } });
  world.emergencyToken = revokeChallenge.body.challengeToken;

  // A: Emergency Access, set up and with an open request from the contact
  const setupChallenge = await api('POST', '/api/emergency/challenge', { token: A.token, json: { action: 'setup' } });
  const setup = await api('POST', '/api/emergency/setup', {
    token: A.token,
    json: { contactEmail: A_CONTACT, contactLabel: 'Sam', waitMinutes: 4320, scope: { mode: 'all' }, challengeToken: setupChallenge.body.challengeToken, code: codeFromMail(lastMailTo(A_EMAIL)) },
  });
  assert.equal(setup.status, 201, setup.text);
  world.kit = setup.body.kit;
  assert.equal((await api('POST', '/api/emergency/public/request-code', { json: { ownerEmail: A_EMAIL, contactEmail: A_CONTACT } })).status, 200);
  const requested = await api('POST', '/api/emergency/public/request', {
    json: { ownerEmail: A_EMAIL, contactEmail: A_CONTACT, code: codeFromMail(lastMailTo(A_CONTACT)), kit: world.kit },
  });
  assert.equal(requested.status, 201, requested.text);
  world.requestId = String((await M.EmergencyRequest.findOne({ userId: A.userId }).lean())._id);

  // B: some data of its own, so "B sees only B" is a real statement and not an empty list
  assert.equal((await api('POST', '/api/documents/folders', { token: B.token, json: { name: 'B-Folder', parentPath: '' } })).status, 201);
  const bDoc = await api('POST', '/api/documents', { token: B.token, form: textFile('B-note.txt', 'B note', 'B-Folder') });
  assert.equal(bDoc.status, 201, bDoc.text);
  world.bDocId = bDoc.body.id;
  assert.equal((await api('POST', `/api/documents/${world.bDocId}/share`, { token: B.token, json: { durationHours: 24 } })).status, 201);
}

/** Everything A's identifiers could appear as in a response to B. */
function markers() {
  return [
    world.docId, world.docId2, world.trashedDocId, world.trashedFolderId, world.shareId, world.shareId2, world.shareKey, world.deviceId, world.trustedId,
    world.requestId, world.folderRowId, world.A.userId, A_EMAIL, A_CONTACT, A_HIDDEN, 'A-secret', 'A-in-trashed-folder', 'A-trusted-browser', 'A secret', 'hidden',
  ];
}

/** A digest of every row of A's, so "nothing of A's changed" is one comparison. */
async function snapshotOfA() {
  const M = live.mongoose.models;
  const userId = world.A.userId;
  const shareIds = (await M.Share.find({ ownerUserId: userId }).lean()).map((share) => share.shareId);
  const rows = {
    user: await M.User.find({ _id: userId }).lean(),
    documents: await M.Document.find({ userId }).sort({ _id: 1 }).lean(),
    folders: await M.Folder.find({ userId }).sort({ _id: 1 }).lean(),
    trashFolders: await M.TrashFolder.find({ userId }).sort({ _id: 1 }).lean(),
    shares: await M.Share.find({ ownerUserId: userId }).sort({ _id: 1 }).lean(),
    sharedFiles: await M.SharedFile.find({ shareId: { $in: shareIds } }).sort({ _id: 1 }).lean(),
    devices: await M.Device.find({ userId }).sort({ _id: 1 }).lean(),
    trusted: await M.TrustedDevice.find({ userId }).sort({ _id: 1 }).lean(),
    sessions: await M.Session.find({ userId }).sort({ _id: 1 }).lean(),
    events: await M.AuditEvent.find({ userId }).sort({ seq: 1 }).lean(),
    emergencyAccess: await M.EmergencyAccess.find({ userId }).sort({ _id: 1 }).lean(),
    emergencyRequests: await M.EmergencyRequest.find({ userId }).sort({ _id: 1 }).lean(),
    reminders: await M.ReminderLog.find({ userId }).sort({ _id: 1 }).lean(),
  };
  const counts = Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, value.length]));
  return { digest: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'), counts };
}

// ---------- the plan: what B does to each owner route ----------
// kind 'foreign': the request names an object of A's; the answer must be one of `expect`.
// kind 'own':     there is nothing to name (or it is B's own), so the answer must be B's own data and none of A's.
// `why` explains every status other than 403/404.
const withFile = (name) => {
  const form = new FormData();
  form.append('thumb', new Blob([Buffer.from('not really an image')], { type: 'image/png' }), name);
  return form;
};
const D = '/api/documents';
const aPasswordBody = () => ({ salt: Buffer.alloc(16, 1).toString('base64'), kdf: { N: 16384, r: 8, p: 1 }, wrappedKey: Buffer.alloc(60, 2).toString('base64'), verifier: Buffer.alloc(32, 3).toString('base64') });

function plan() {
  const w = world;
  const GONE = [403, 404];
  return {
    // auth
    'GET /api/auth/me': { kind: 'own' },
    // documents
    [`DELETE ${D}/folders`]: {
      kind: 'foreign', expect: [204], query: { path: A_FOLDER },
      why: 'folder delete is idempotent: a folder B does not have is a successful no-op. That it touched nothing of A’s is shown by the end-of-run comparison of A’s rows',
    },
    [`DELETE ${D}/:id`]: { kind: 'foreign', expect: GONE, params: { id: w.docId } },
    [`POST ${D}`]: { kind: 'own', form: () => textFile('B-second.txt', 'x', A_FOLDER) },
    [`GET ${D}`]: { kind: 'own', query: { folder: A_FOLDER } },
    [`GET ${D}/expiring`]: { kind: 'own' },
    [`GET ${D}/folders`]: { kind: 'own' },
    [`GET ${D}/folders/children`]: { kind: 'own', query: { path: A_FOLDER } },
    [`GET ${D}/photos`]: { kind: 'own' },
    [`GET ${D}/storage`]: { kind: 'own' },
    // Folders are named per account, so B naming "A-Private-Folder" creates / renames B's OWN folder of that name. These are
    // 'own': what matters is that A's folder is untouched (the end-of-run comparison) and that nothing of A's is shown.
    [`POST ${D}/folders`]: { kind: 'own', json: { name: 'planted', parentPath: A_FOLDER } },
    [`PATCH ${D}/folders`]: { kind: 'own', json: { path: A_FOLDER, name: 'renamed-by-b' } },
    [`POST ${D}/move`]: {
      kind: 'foreign', expect: [200], json: { items: [{ type: 'file', id: w.docId }, { type: 'folder', path: A_FOLDER }], destination: '' },
      why: 'a move answers per item; the check is that every item came back "not_found" (see `after`)',
      after: (res) => assert.ok(res.body.results.every((item) => /not.?found/i.test(JSON.stringify(item))), `every item not found: ${res.text}`),
    },
    [`GET ${D}/:id/view`]: { kind: 'foreign', expect: GONE, params: { id: w.docId } },
    [`POST ${D}/:id/downloaded`]: { kind: 'foreign', expect: GONE, params: { id: w.docId } },
    [`GET ${D}/:id/thumbnail`]: { kind: 'foreign', expect: GONE, params: { id: w.docId } },
    [`PUT ${D}/:id/thumbnail`]: { kind: 'foreign', expect: GONE, params: { id: w.docId }, form: () => withFile('thumb.png') },
    [`POST ${D}/thumbnails/retry`]: { kind: 'own' },
    [`POST ${D}/:id/thumbnail-failed`]: { kind: 'foreign', expect: GONE, params: { id: w.docId }, json: { reason: 'decode-failed', kind: 'image' } },
    [`PATCH ${D}/:id`]: { kind: 'foreign', expect: GONE, params: { id: w.docId }, json: { filename: 'pwned.txt', folder: '', expiryDate: null } },
    [`POST ${D}/:id/share`]: { kind: 'foreign', expect: GONE, params: { id: w.docId }, json: { durationHours: 24 } },
    [`GET ${D}/:id/shares`]: { kind: 'foreign', expect: GONE, params: { id: w.docId } },
    // shares (owner side)
    'POST /api/shares': { kind: 'foreign', expect: GONE, json: { documentIds: [w.docId, w.docId2] } },
    'GET /api/shares': { kind: 'own' },
    'DELETE /api/shares': { kind: 'own' },
    'GET /api/shares/usage': { kind: 'own' },
    'PATCH /api/shares/:shareId': { kind: 'foreign', expect: GONE, params: { shareId: w.shareId }, json: { maxDownloads: 50 } },
    'GET /api/shares/:shareId/manifest': { kind: 'foreign', expect: GONE, params: { shareId: w.shareId } },
    'GET /api/shares/:shareId/protection': { kind: 'foreign', expect: GONE, params: { shareId: w.shareId } },
    'PUT /api/shares/:shareId/password': { kind: 'foreign', expect: GONE, params: { shareId: w.shareId }, json: aPasswordBody() },
    'DELETE /api/shares/:shareId/password': { kind: 'foreign', expect: GONE, params: { shareId: w.shareId } },
    'DELETE /api/shares/:shareId': { kind: 'foreign', expect: GONE, params: { shareId: w.shareId } },
    // account
    'GET /api/account/health': { kind: 'own' },
    'GET /api/account/preferences': { kind: 'own' },
    'PATCH /api/account/preferences': { kind: 'own', json: { expiryReminders: false } },
    'POST /api/account/delete-challenge': { kind: 'own', json: { password: PASSWORD } },
    'POST /api/account/resend-delete-code': { kind: 'foreign', expect: [401], json: () => ({ challengeToken: w.deleteToken }), why: "the token is a credential, not an object id: a challenge that is not B's is refused like any invalid code" },
    'DELETE /api/account': { kind: 'foreign', expect: [401], json: () => ({ challengeToken: w.deleteToken, code: '000000', emailConfirmation: B_EMAIL }), why: 'same: A’s challenge token is not usable by B (B types its own address, so the token is what is tested)' },
    'GET /api/account/trusted-devices': { kind: 'own' },
    'DELETE /api/account/trusted-devices': { kind: 'own' },
    'DELETE /api/account/trusted-devices/:id': { kind: 'foreign', expect: GONE, params: { id: w.trustedId } },
    // emergency (owner side)
    'GET /api/emergency/status': { kind: 'own' },
    'GET /api/emergency/session-info': { kind: 'own' },
    'GET /api/emergency/folders': { kind: 'own' },
    'POST /api/emergency/challenge': { kind: 'own', json: { action: 'setup' } },
    'POST /api/emergency/challenge/resend': { kind: 'foreign', expect: [401], json: () => ({ challengeToken: w.emergencyToken }), why: "A's challenge token is not B's: refused like any invalid code" },
    'POST /api/emergency/setup': {
      kind: 'foreign', expect: [400], why: 'the folder scope names A’s folder id; it is checked against B’s own folders first and refused (the same answer as a folder that does not exist)',
      json: () => ({ contactEmail: 'b.contact@example.com', waitMinutes: 4320, scope: { mode: 'folders', folderIds: [w.folderRowId] }, challengeToken: w.emergencyToken, code: '000000' }),
    },
    'POST /api/emergency/regenerate-kit': { kind: 'foreign', expect: GONE, json: () => ({ challengeToken: w.emergencyToken, code: '000000' }) },
    'POST /api/emergency/revoke': { kind: 'foreign', expect: GONE, json: () => ({ challengeToken: w.emergencyToken, code: '000000' }) },
    'POST /api/emergency/requests/:id/deny': { kind: 'foreign', expect: [409], params: { id: w.requestId }, why: 'a deny that matches no request of B’s says "can no longer be denied", the same answer for an id that does not exist' },
    'POST /api/emergency/requests/:id/approve-now': { kind: 'foreign', expect: GONE, params: { id: w.requestId }, json: () => ({ challengeToken: w.emergencyToken, code: '000000' }) },
    // security
    'GET /api/security/devices': { kind: 'own' },
    'POST /api/security/devices/sign-out-others': { kind: 'own' },
    'POST /api/security/devices/:id/sign-out': { kind: 'foreign', expect: GONE, params: { id: w.deviceId } },
    'POST /api/security/devices/:id/forget-trusted': { kind: 'foreign', expect: GONE, params: { id: w.deviceId }, json: { forgetTrusted: true } },
    'GET /api/security/activity': { kind: 'own', query: { device: w.deviceId, limit: '200' } },
    'POST /api/security/verify-log': { kind: 'own' },
    'POST /api/security/client-event': { kind: 'own', json: { type: 'export' } },
    // insights
    'GET /api/insights/overview': { kind: 'own' },
    'GET /api/insights/stale': { kind: 'own' },
    'GET /api/insights/frequent': { kind: 'own' },
    // trash
    'GET /api/trash': { kind: 'own' },
    'POST /api/trash/restore': { kind: 'foreign', expect: GONE, json: () => ({ kind: 'file', id: w.trashedDocId }) },
    'DELETE /api/trash': { kind: 'own' },
    'DELETE /api/trash/:kind/:id': { kind: 'foreign', expect: GONE, params: { kind: 'file', id: w.trashedDocId } },
    // last: it ends B's session
    'POST /api/auth/logout': { kind: 'own' },
  };
}

const resolve = (value) => (typeof value === 'function' ? value() : value);

it('the routes that need no session are exactly the known public set', async () => {
  const routes = enumerateRoutes(live.app);
  const open = routes.filter((route) => !route.guarded).map((route) => `${route.method} ${route.path}`);
  const unknown = open.filter((key) => !PUBLIC_ROUTES.has(key));
  const missing = [...PUBLIC_ROUTES].filter((key) => !open.includes(key));
  assert.deepEqual(unknown, [], `routes with no session that are not on the public list: ${unknown.join(', ')}`);
  assert.deepEqual(missing, [], `public routes that disappeared (update the list): ${missing.join(', ')}`);
});

it('B cannot read, change, delete or even detect A’s data on any owner route', async () => {
  const { api } = live;
  await buildWorld();
  const before = await snapshotOfA();
  const routes = enumerateRoutes(live.app).filter((route) => route.guarded);
  const plans = plan();

  // every owner route has a plan, and every plan is for a real route
  const keys = routes.map((route) => `${route.method} ${route.path}`);
  assert.deepEqual(keys.filter((key) => !plans[key]), [], 'owner routes without a cross-user plan (add one in plan())');
  assert.deepEqual(Object.keys(plans).filter((key) => !keys.includes(key)), [], 'plans for routes that no longer exist');

  const scan = markers();
  const results = [];
  const problems = [];
  // the logout route goes last: it ends B's session
  const ordered = [...routes].sort((a, b) => Number(a.path === '/api/auth/logout') - Number(b.path === '/api/auth/logout'));
  for (const route of ordered) {
    const key = `${route.method} ${route.path}`;
    const entry = plans[key];
    let path = route.path;
    for (const [name, value] of Object.entries(entry.params || {})) path = path.replace(`:${name}`, value);
    assert.ok(!path.includes(':'), `${key}: unfilled parameter in ${path}`);
    const json = resolve(entry.json);
    const form = entry.form ? entry.form() : undefined;
    const res = await api(route.method, path, { token: world.B.token, json, form, query: entry.query });
    results.push({ key, status: res.status, kind: entry.kind });

    // never a server error, and never any of A's identifiers or content in the answer
    if (res.status >= 500) problems.push(`${key} -> ${res.status} ${res.text.slice(0, 160)}`);
    const sent = `${path} ${JSON.stringify(entry.query || {})} ${JSON.stringify(json || {})}`;
    for (const marker of scan) if (!sent.includes(marker) && res.text.includes(marker)) problems.push(`${key} -> ${res.status} leaked A's "${marker}": ${res.text.slice(0, 200)}`);

    if (entry.kind === 'foreign') {
      if (!entry.expect.includes(res.status)) problems.push(`${key} named A's object and got ${res.status} (expected ${entry.expect.join('/')}): ${res.text.slice(0, 200)}`);
      else if (entry.after) {
        try {
          entry.after(res);
        } catch (err) {
          problems.push(`${key}: ${err.message}`);
        }
      }
    } else if (res.status === 401) {
      problems.push(`${key} (B's own) -> 401 ${res.text.slice(0, 160)}`);
    }
  }
  assert.deepEqual(problems, [], `cross-user problems: ${problems.join(' | ')}`);

  // B's own listings are really B's: there was something to see, and it is B's
  const own = await api('GET', '/api/documents', { token: world.B.token });
  assert.equal(own.status, 401, 'B logged out at the end, as planned');
  const again = await signUpAndInAgain(B_EMAIL);
  const listing = await api('GET', '/api/documents', { token: again });
  assert.match(listing.text, /B-note\.txt/);

  // A's rows are exactly what they were
  const after = await snapshotOfA();
  assert.deepEqual(after.counts, before.counts, 'row counts of A’s data');
  assert.equal(after.digest, before.digest, 'A’s rows changed while B was probing');

  // and A can still use all of it
  const { token } = world.A;
  assert.equal((await api('GET', `/api/documents/${world.docId}/view`, { token })).status, 200);
  assert.equal((await api('GET', `/api/shares/${world.shareId}/protection`, { token })).status, 200);
  assert.equal((await api('GET', '/api/emergency/status', { token })).body.request.id, world.requestId);
  assert.ok((await api('GET', '/api/trash', { token })).body.items.length >= 2);

  const foreign = results.filter((r) => r.kind === 'foreign');
  const named = [...new Set(markers().filter((m) => /^[0-9a-f]{24}$|^[0-9a-f]{32}$/.test(m)))];
  console.log(`cross-user: ${results.length} owner routes called as B (${foreign.length} naming A's objects, ${results.length - foreign.length} with nothing to name), ${named.length} distinct A identifiers planted, ${PUBLIC_ROUTES.size} public routes on the allow-list`);
});

async function signUpAndInAgain(email) {
  const login = await live.api('POST', '/api/auth/unlock', { json: { email, password: PASSWORD } });
  assert.equal(login.status, 200, login.text);
  return login.body.sessionToken;
}
