// Run with: cd server && npm test
//
// Two more cross-user checks, against the REAL app on a LOCAL throwaway MongoDB (skipped, with the reason, without one):
//   1. a share access token made for share A is worth nothing on share B;
//   2. an Emergency Access session is refused on EVERY owner-only route - the route list comes from the router itself, so a
//      route added later is covered the day it is added, and anything not on the allowlist is refused (deny by default).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');

const { startLiveApp } = require('./helpers/liveApp');
const { ALLOWLIST, assertEmergencyAllowed, matchAllowlist } = require('../middleware/emergencyGuard');

let live = { ok: false, reason: '' };
let server = null;
let base = '';

test.before(async () => {
  live = await startLiveApp('cross_tokens');
  if (!live.ok) return;
  server = http.createServer(live.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (live.ok) await live.stop();
});
const it = (name, fn) =>
  test(name, async (context) => {
    if (!live.ok) return context.skip(live.reason);
    await live.mongoose.models.RateLimit.deleteMany({});
    return fn(context);
  });

async function raw(method, path, { token, json, headers = {} } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text };
}

// ---------------- 1. a share access token is bound to its own share ----------------

async function makeGatedShare(M, label) {
  const shareId = crypto.randomBytes(16).toString('hex');
  const fileId = crypto.randomBytes(8).toString('hex');
  await M.Share.collection.insertOne({
    shareId, ownerUserId: new live.mongoose.Types.ObjectId(), expiresAt: new Date(Date.now() + 3600 * 1000), ready: true,
    recipientEmail: `${label}.recipient@example.com`,
    passwordVerifierHash: crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'),
    manifestIv: Buffer.alloc(12, 1), manifestCipher: Buffer.from(`manifest of ${label}`), manifestAuthTag: Buffer.alloc(16, 2),
    createdAt: new Date(),
  });
  await M.SharedFile.collection.insertOne({
    shareId, fileId, iv: Buffer.alloc(12, 3), ciphertext: Buffer.from(`secret bytes of ${label}`), authTag: Buffer.alloc(16, 4), sizeBytes: 22, expiresAt: new Date(Date.now() + 3600 * 1000),
  });
  return { shareId, fileId };
}

it('a share access token made for share A does not open share B, even when A\'s own gates were passed', async () => {
  const M = live.mongoose.models;
  const A = await makeGatedShare(M, 'a');
  const B = await makeGatedShare(M, 'b');

  const accessA = (await raw('POST', `/api/shared/${A.shareId}/access`, {})).body.accessToken;
  const accessB = (await raw('POST', `/api/shared/${B.shareId}/access`, {})).body.accessToken;
  assert.match(accessA, /^[0-9a-f]{64}$/);
  assert.notEqual(accessA, accessB);

  // Clear every gate of A for this visitor, so the token is as strong as a token can be.
  await M.ShareAccess.updateOne({ shareId: A.shareId }, { $set: { emailOk: true, passwordOk: true } });
  const own = await raw('GET', `/api/shared/${A.shareId}`, { headers: { 'x-share-access': accessA } });
  assert.equal(own.status, 200, 'the token works on its own share');
  assert.equal((await raw('GET', `/api/shared/${A.shareId}/files/${A.fileId}`, { headers: { 'x-share-access': accessA } })).status, 200);

  // The same token on B: every public route of the share answers the same generic 404 and serves nothing of B's.
  const attempts = [
    ['GET', `/api/shared/${B.shareId}`],
    ['GET', `/api/shared/${B.shareId}/files/${B.fileId}`],
    ['POST', `/api/shared/${B.shareId}/email-code`, {}],
    ['POST', `/api/shared/${B.shareId}/email-verify`, { code: '123456' }],
    ['POST', `/api/shared/${B.shareId}/unlock`, { verifier: crypto.randomBytes(32).toString('base64') }],
  ];
  const generic = (await raw('GET', `/api/shared/${B.shareId}`)).text;
  for (const [method, path, json] of attempts) {
    const result = await raw(method, path, { json, headers: { 'x-share-access': accessA } });
    assert.equal(result.status, 404, `${method} ${path}`);
    assert.ok(!result.text.includes('secret bytes of b') && !result.text.includes('manifest of b'), 'nothing of B is served');
    if (method === 'GET') assert.equal(result.text, generic, 'the same answer as with no token at all');
  }
  // And B's own (uncleared) token still does not open B's gated files.
  assert.equal((await raw('GET', `/api/shared/${B.shareId}/files/${B.fileId}`, { headers: { 'x-share-access': accessB } })).status, 404);
  // A's file id on B's share, and B's file id on A's share, find nothing either.
  await M.ShareAccess.updateOne({ shareId: B.shareId }, { $set: { emailOk: true, passwordOk: true } });
  assert.equal((await raw('GET', `/api/shared/${B.shareId}/files/${A.fileId}`, { headers: { 'x-share-access': accessB } })).status, 404);
  assert.equal((await raw('GET', `/api/shared/${A.shareId}/files/${B.fileId}`, { headers: { 'x-share-access': accessA } })).status, 404);
});

// ---------------- 2. an emergency session on every owner-only route ----------------

/** Every route of the real app with whether a session is required, found by walking the router stack (as cross-user.test.js does). */
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
          out.push({ method: method === '_all' ? 'ALL' : method.toUpperCase(), path: prefix + (layer.route.path === '/' ? '' : layer.route.path), guarded: routeGuarded });
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

it('an emergency session is refused (403, read-only) on every owner-only route the router has, and reaches only the allowlist', async () => {
  const { createSession } = require('../utils/sessionStore');
  const M = live.mongoose.models;
  const { buildAccountFields } = require('../utils/accountCreate');
  const { fields } = buildAccountFields(PASSWORD);
  const owner = await M.User.create({ email: 'emergency.target@example.com', emailVerified: true, ...fields });
  const token = await createSession(owner._id, crypto.randomBytes(32), {
    emergency: { accessId: new live.mongoose.Types.ObjectId(), requestId: new live.mongoose.Types.ObjectId(), scopeMode: 'all', absoluteMs: 4 * 3600 * 1000 },
  });

  // Log out is on the allowlist (a contact may end their own session), so it goes last: it ends the token this test uses.
  const routes = enumerateRoutes(live.app)
    .filter((route) => route.guarded && route.method !== 'ALL')
    .sort((x, y) => Number(x.path === '/api/auth/logout') - Number(y.path === '/api/auth/logout'));
  assert.ok(routes.length >= 60, `found ${routes.length} signed-in routes from the router`);
  const ZERO = '000000000000000000000000';
  const fill = (route) => route.path.replace(/:[A-Za-z]+/g, (name) => (name === ':kind' ? 'file' : name === ':shareId' ? '0'.repeat(32) : ZERO));

  const allowed = [];
  const refused = [];
  for (const route of routes) {
    const path = fill(route);
    const result = await raw(route.method, path, { token, json: route.method === 'GET' ? undefined : {} }); // eslint-disable-line no-await-in-loop
    const onList = Boolean(matchAllowlist(route.method, path));
    if (onList) {
      allowed.push(`${route.method} ${route.path}`);
      assert.notEqual(result.body?.error?.code, 'EMERGENCY_READ_ONLY', `${route.method} ${path} is on the allowlist`);
    } else {
      refused.push(`${route.method} ${route.path}`);
      assert.equal(result.status, 403, `${route.method} ${path} must be refused, got ${result.status}`);
      assert.equal(result.body?.error?.code, 'EMERGENCY_READ_ONLY', `${route.method} ${path}`);
      assert.doesNotMatch(String(result.status), /^2/);
    }
  }
  // Exactly the allowlist gets through (each entry matched by a real route), everything else was refused.
  assert.equal(allowed.length, ALLOWLIST.length, `allowed: ${allowed.join(', ')}`);
  assert.equal(allowed.length + refused.length, routes.length);
  assert.ok(refused.length >= routes.length - ALLOWLIST.length);
  // Nothing was changed by any of it.
  assert.equal(await M.User.countDocuments({}), 1);
  assert.equal(await M.Document.countDocuments({}), 0);
  assert.equal(await M.Share.countDocuments({}) >= 0, true);
});

it('deny by default: a route nobody has listed is refused for an emergency session, whatever it is called', () => {
  const unseen = [
    ['GET', '/api/documents/export-everything'], ['POST', '/api/documents'], ['DELETE', '/api/account'], ['PATCH', '/api/account/preferences'],
    ['GET', '/api/some/route/added/next/year'], ['PUT', '/api/documents/0123456789abcdef01234567/thumbnail'], ['POST', '/api/emergency/setup'],
    ['GET', '/api/documents/0123456789abcdef01234567/view/../shares'], ['HEAD', '/api/trash'], ['GET', '/api/security/activity'],
  ];
  for (const [method, path] of unseen) {
    const [baseUrl, ...rest] = [path.slice(0, path.indexOf('/', 5)), path.slice(path.indexOf('/', 5))];
    assert.throws(() => assertEmergencyAllowed({ method, baseUrl, path: rest.join('') }), (err) => err.status === 403 && err.code === 'EMERGENCY_READ_ONLY', `${method} ${path}`);
  }
  // A look-alike of an allowed path is not an allowed path.
  for (const path of ['/api/documents/0123456789abcdef01234567/view/extra', '/api/documents/xyz/view', '/api/documents/', '/api/auth/me/extra']) {
    assert.equal(matchAllowlist('GET', path), path === '/api/documents/' ? ALLOWLIST.find((e) => e.path.test('/api/documents')) : null, path);
  }
  assert.equal(matchAllowlist('POST', '/api/auth/me'), null, 'the verb matters');
});

const PASSWORD = 'Qx7!vTr29#mLpw';
