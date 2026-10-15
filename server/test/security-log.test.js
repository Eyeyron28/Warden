// Run with: cd server && npm test
//
// Security events in the server log (utils/securityLog.js): one JSON line per event, with the type, the bucket, a count, the
// request id and the time, and NEVER an email address, a token, a code or an IP address. Runs the REAL app against a LOCAL
// throwaway MongoDB (skipped, with the reason, without one). Mail is captured, no .env is read.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');

const { startLiveApp } = require('./helpers/liveApp');
const { EVENTS, logSecurity, keyedId, resetSecurityLogSampling } = require('../utils/securityLog');

const PASSWORD = 'Qx7!vTr29#mLpw';
let live = { ok: false, reason: '' };
let server = null;
let base = '';

test.before(async () => {
  live = await startLiveApp('security_log');
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
    resetSecurityLogSampling();
    await live.mongoose.models.RateLimit.deleteMany({});
    return fn(context);
  });

/** Runs `fn` while collecting every console.warn line that is a security event. */
async function capture(fn) {
  const lines = [];
  const real = console.warn;
  console.warn = (...args) => {
    const text = args.join(' ');
    try {
      const parsed = JSON.parse(text);
      if (EVENTS.has(parsed.type)) lines.push({ text, parsed });
    } catch {
      // not an event
    }
  };
  try {
    await fn();
  } finally {
    console.warn = real;
  }
  return lines;
}

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
  return { status: response.status, body };
}

const codeFromMail = (mail) => /(?<![\d-])(\d{6})(?![\d-])/.exec(mail.text)[1];
const lastMailTo = (address) => live.mails.filter((mail) => mail.to === address).at(-1);

async function signUp(email) {
  await live.mongoose.models.RateLimit.deleteMany({});
  const started = await raw('POST', '/api/auth/signup/start', { json: { email, password: PASSWORD, termsAccepted: true } });
  assert.equal(started.status, 200);
  const verified = await raw('POST', '/api/auth/signup/verify', { json: { email, password: PASSWORD, code: codeFromMail(lastMailTo(email)) } });
  assert.equal(verified.status, 200);
  const user = await live.mongoose.models.User.findOne({ email }).lean();
  return { email, token: verified.body.sessionToken, userId: user._id };
}

/** The rule for every line: only these fields, ids that are hashes, and nothing that identifies a person or a session. */
function assertClean(lines, secrets) {
  assert.ok(lines.length > 0, 'at least one event line');
  for (const { text, parsed } of lines) {
    assert.deepEqual(Object.keys(parsed).filter((key) => !['type', 'bucket', 'count', 'requestId', 'time', 'subject'].includes(key)), [], `unexpected fields in ${text}`);
    assert.ok(typeof parsed.type === 'string' && 'bucket' in parsed && 'count' in parsed && 'requestId' in parsed && 'time' in parsed, text);
    assert.ok(parsed.count === null || Number.isInteger(parsed.count), text);
    assert.ok(!Number.isNaN(Date.parse(parsed.time)), text);
    if (parsed.subject !== undefined) assert.match(parsed.subject, /^[0-9a-f]{8}$/, 'a truncated keyed hash');
    if (parsed.requestId !== null) assert.match(parsed.requestId, /^[0-9a-f]{12}$/);
    assert.doesNotMatch(text, /@/, 'no email address');
    assert.doesNotMatch(text, /\b(?:\d{1,3}\.){3}\d{1,3}\b|::1|ffff:/i, 'no IP address');
    assert.doesNotMatch(text, /[0-9a-f]{40,}/i, 'no token or long hash');
    for (const secret of secrets) assert.ok(!text.includes(secret), `${text} must not contain a secret`);
  }
}

it('a lockout writes one line: the limiter, the limit, a request id and a hash of the address, never the address', async () => {
  const user = await signUp('lock.me@example.com');
  const lines = await capture(async () => {
    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await raw('POST', '/api/auth/unlock', { json: { email: user.email, password: 'wrong password here' } })).status);
    assert.deepEqual(statuses.slice(0, 2), [401, 401]);
    assert.equal(statuses[2], statuses[3], 'the third wrong password switches the lock on; the fourth meets it');
    assert.notEqual(statuses[2], 401);
  });
  const lockouts = lines.filter((line) => line.parsed.type === 'lockout');
  assert.equal(lockouts.length, 1, 'once, for the attempt that switched the lock on');
  assert.equal(lockouts[0].parsed.bucket, 'login');
  assert.equal(lockouts[0].parsed.count, 3);
  assert.equal(lockouts[0].parsed.subject, keyedId('lock.me@example.com'));
  assert.ok(lockouts[0].parsed.requestId);
  assertClean(lockouts, [user.email, PASSWORD, user.token]);
});

it('three or more wrong guesses on one emailed code are logged, with the purpose and a hashed challenge id', async () => {
  const email = 'code.burst@example.com';
  await raw('POST', '/api/auth/signup/start', { json: { email, password: PASSWORD, termsAccepted: true } });
  const realCode = codeFromMail(lastMailTo(email));
  const wrong = realCode === '000000' ? '111111' : '000000';
  const lines = await capture(async () => {
    for (let i = 0; i < 4; i += 1) assert.equal((await raw('POST', '/api/auth/signup/verify', { json: { email, password: PASSWORD, code: wrong } })).status, 401);
  });
  const bursts = lines.filter((line) => line.parsed.type === 'code_failures');
  assert.deepEqual(bursts.map((line) => line.parsed.count), [3, 4], 'from the third wrong guess on');
  assert.ok(bursts.every((line) => line.parsed.bucket === 'signup'));
  assertClean(bursts, [email, realCode, wrong, PASSWORD]);
});

it('requests refused with 429 are logged by limiter bucket, and a flood is thinned out', async () => {
  const lines = await capture(async () => {
    for (let i = 0; i < 14; i += 1) await raw('POST', '/api/auth/signup/start', { json: { email: `flood${i}@example.com`, password: PASSWORD, termsAccepted: true } });
  });
  const limited = lines.filter((line) => line.parsed.type === 'rate_limited');
  assert.ok(limited.length >= 1 && limited.length <= 5, `${limited.length} lines for 4 refused requests`);
  assert.equal(limited[0].parsed.bucket, 'signup-ip');
  assert.equal(limited[0].parsed.count, 11, 'the first request past the limit of 10');
  assert.ok(limited[0].parsed.subject, 'the caller only as a hash');
  assertClean(limited, ['flood0@example.com']);

  // The thinning, directly: a hundred events in a minute are far fewer lines.
  resetSecurityLogSampling();
  const flood = await capture(async () => {
    for (let i = 0; i < 100; i += 1) logSecurity('rate_limited', { bucket: 'x', count: i });
  });
  assert.ok(flood.length >= 5 && flood.length <= 10, `${flood.length} lines for 100 events`);
});

it('sessions ended by "sign out everywhere else" and by a password reset are logged with how many', async () => {
  const { createSession, destroyAllSessionsForUser } = require('../utils/sessionStore');
  const user = await signUp('revoke.me@example.com');
  const dek = crypto.randomBytes(32);
  await createSession(user.userId, dek);
  await createSession(user.userId, dek);
  const lines = await capture(async () => {
    assert.equal((await raw('POST', '/api/security/devices/sign-out-others', { token: user.token })).status, 200);
    await destroyAllSessionsForUser(user.userId);
  });
  const revoked = lines.filter((line) => line.parsed.type === 'sessions_revoked');
  assert.deepEqual(revoked.map((line) => [line.parsed.bucket, line.parsed.count]), [['sign-out-others', 2], ['reset', 1]]);
  assertClean(revoked, [user.email, user.token]);
});

it('an emergency session refused by the guard, and an owner denying a request, are logged', async () => {
  const { createSession } = require('../utils/sessionStore');
  const M = live.mongoose.models;
  const owner = await signUp('emergency.owner@example.com');
  const emergencyToken = await createSession(owner.userId, crypto.randomBytes(32), {
    emergency: { accessId: new live.mongoose.Types.ObjectId(), requestId: new live.mongoose.Types.ObjectId(), scopeMode: 'all', absoluteMs: 4 * 3600 * 1000 },
  });
  const request = await M.EmergencyRequest.create({
    accessId: new live.mongoose.Types.ObjectId(), userId: owner.userId, status: 'pending', active: true,
    requestedAt: new Date(), releaseAt: new Date(Date.now() + 3 * 86400000), claimExpiresAt: new Date(Date.now() + 6 * 86400000),
  });
  const lines = await capture(async () => {
    const refused = await raw('DELETE', `/api/documents/${new live.mongoose.Types.ObjectId()}`, { token: emergencyToken });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'EMERGENCY_READ_ONLY');
    assert.equal((await raw('POST', `/api/emergency/requests/${request._id}/deny`, { token: owner.token, json: {} })).status, 200);
  });
  assert.deepEqual(lines.map((line) => [line.parsed.type, line.parsed.bucket]), [['emergency_refused', 'allowlist'], ['emergency_denied', 'owner']]);
  assertClean(lines, [owner.email, emergencyToken, owner.token]);
});

it('wrong passwords on a share link are logged from the third one in a window, by link (hashed), never with the verifier', async () => {
  const M = live.mongoose.models;
  const shareId = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(32);
  await M.Share.collection.insertOne({
    shareId, ownerUserId: new live.mongoose.Types.ObjectId(), expiresAt: new Date(Date.now() + 3600 * 1000), ready: true,
    passwordVerifierHash: crypto.createHash('sha256').update(verifier).digest('hex'), createdAt: new Date(),
  });
  const access = await raw('POST', `/api/shared/${shareId}/access`, {});
  assert.equal(access.status, 200);
  const token = access.body.accessToken;
  const guess = crypto.randomBytes(32).toString('base64');
  const lines = await capture(async () => {
    for (let i = 0; i < 4; i += 1) assert.equal((await raw('POST', `/api/shared/${shareId}/unlock`, { json: { verifier: guess }, headers: { 'x-share-access': token } })).status, 401);
  });
  const failures = lines.filter((line) => line.parsed.type === 'share_password_failures');
  assert.deepEqual(failures.map((line) => line.parsed.count), [3, 4]);
  assert.equal(failures[0].parsed.bucket, 'share-password');
  assert.equal(failures[0].parsed.subject, keyedId(shareId));
  assertClean(failures, [shareId, guess, token, verifier.toString('base64')]);
});

it('the daily mail budget reports once a day, in counts only', async () => {
  const { reserveMail, resetMailReports, bulkLimit } = require('../utils/mailBudget');
  resetMailReports();
  await live.mongoose.models.RateLimit.deleteMany({});
  const lines = await capture(async () => {
    for (let i = 0; i < bulkLimit(); i += 1) await reserveMail('bulk');
    for (let i = 0; i < 4; i += 1) assert.equal(await reserveMail('bulk'), false);
  });
  assert.equal(lines.filter((line) => line.parsed.type === 'mail_cap').length, 1, 'logged once');
  assert.equal(lines[0].parsed.bucket, 'bulk');
  assert.equal(lines[0].parsed.count, bulkLimit());
  assertClean(lines, []);
});

it('an unknown event type, or a logging problem, is ignored and never reaches the caller', () => {
  const real = console.warn;
  let wrote = 0;
  console.warn = () => { wrote += 1; };
  try {
    logSecurity('not_an_event', { bucket: 'x' });
    assert.equal(wrote, 0);
    console.warn = () => { throw new Error('stdout closed'); };
    assert.doesNotThrow(() => logSecurity('lockout', { bucket: 'login', count: 3 }));
  } finally {
    console.warn = real;
  }
});
