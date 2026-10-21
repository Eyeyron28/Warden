const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { startLiveApp } = require('./helpers/liveApp');
const S = require('./helpers/riskySamples');
const limits = require('../utils/uploadLimits');
const { resetSecurityLogSampling } = require('../utils/securityLog');

const PASSWORD = 'Qx7!vTr29#mLpw';
const KEYS = ['UPLOAD_HOURLY_LIMIT', 'UPLOAD_MINUTE_LIMIT', 'MAX_DOCUMENTS_PER_ACCOUNT'];
let live = { ok: false, reason: '' };

test.before(async () => {
  live = await startLiveApp('upload_limits');
});
test.after(async () => {
  for (const key of KEYS) delete process.env[key];
  if (live.ok) await live.stop();
});
const it = (name, fn) =>
  test(name, async (context) => {
    if (!live.ok) return context.skip(live.reason);
    for (const key of KEYS) delete process.env[key];
    const { mongoose } = live;
    await mongoose.connection.dropDatabase();
    await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));
    live.mails.length = 0;
    resetSecurityLogSampling();
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
const call = (method, path, options = {}) => live.api(method, path, { ...options, keepLimits: true });
const send = (user, name = 'note.txt', buffer = Buffer.from('hello'), { uploadKey } = {}) => {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'text/plain' }), name);
  if (uploadKey) form.append('uploadKey', uploadKey);
  return call('POST', D, { token: user.token, form });
};
const docCount = () => live.mongoose.models.Document.countDocuments({});
const bucketRow = (bucket, user) => live.mongoose.models.RateLimit.findOne({ bucket, key: String(user.userId) }).lean();

async function logged(fn) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

it('defaults: 600 an hour and 120 a minute; env overrides work and anything that is not a positive whole number is ignored', () => {
  assert.equal(limits.hourlyLimit(), 600);
  assert.equal(limits.minuteLimit(), 120);
  assert.equal(limits.maxDocuments(), 2000);
  process.env.UPLOAD_HOURLY_LIMIT = '7';
  process.env.UPLOAD_MINUTE_LIMIT = ' 3 ';
  process.env.MAX_DOCUMENTS_PER_ACCOUNT = '5';
  assert.deepEqual([limits.hourlyLimit(), limits.minuteLimit(), limits.maxDocuments()], [7, 3, 5]);
  for (const bad of ['0', '-4', '1.5', 'abc', '', '1e3', '12px', '9007199254740993999']) {
    process.env.UPLOAD_HOURLY_LIMIT = bad;
    process.env.UPLOAD_MINUTE_LIMIT = bad;
    process.env.MAX_DOCUMENTS_PER_ACCOUNT = bad;
    assert.deepEqual([limits.hourlyLimit(), limits.minuteLimit(), limits.maxDocuments()], [600, 120, 2000], `"${bad}" is ignored`);
  }
});

it('the 121st upload in a minute is refused with 429 UPLOAD_RATE_LIMITED, a Retry-After header and the uniform error shape', async () => {
  const a = await account('lim.minute@example.com');
  await live.mongoose.models.RateLimit.create({ bucket: 'docs-upload-minute', key: String(a.userId), count: 120, windowExpiresAt: new Date(Date.now() + 40 * 1000) });
  const res = await send(a);
  assert.equal(res.status, 429, res.text);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error.status, 429);
  assert.equal(res.body.error.code, 'UPLOAD_RATE_LIMITED');
  assert.match(res.body.error.message, /Too many uploads/);
  const retry = Number(res.headers.get('retry-after'));
  assert.ok(retry >= 1 && retry <= 41, `Retry-After ${retry}`);
  assert.equal(res.body.error.retryAfterSeconds, retry);
  assert.equal(await docCount(), 0, 'nothing stored');
});

it('the 601st upload in an hour is refused the same way (the hour counter, not the minute one)', async () => {
  const a = await account('lim.hour@example.com');
  await live.mongoose.models.RateLimit.create({ bucket: 'docs-upload-hour', key: String(a.userId), count: 600, windowExpiresAt: new Date(Date.now() + 1800 * 1000) });
  const res = await send(a);
  assert.equal(res.status, 429);
  assert.equal(res.body.error.code, 'UPLOAD_RATE_LIMITED');
  const retry = Number(res.headers.get('retry-after'));
  assert.ok(retry > 1700 && retry <= 1800, `Retry-After ${retry}`);
});

it('the limit is counted per account: another account is not affected', async () => {
  const a = await account('lim.a@example.com');
  const b = await account('lim.b@example.com');
  process.env.UPLOAD_MINUTE_LIMIT = '2';
  assert.equal((await send(a, 'one.txt')).status, 201);
  assert.equal((await send(a, 'two.txt')).status, 201);
  assert.equal((await send(a, 'three.txt')).status, 429);
  assert.equal((await send(b, 'one.txt')).status, 201, 'b has its own budget');
  assert.ok(await bucketRow('docs-upload-minute', a));
  assert.ok(await bucketRow('docs-upload-minute', b));
});

it('the check runs before any heavy work: a limited upload never reaches the scanner or the encryption', async () => {
  const a = await account('lim.spy@example.com');
  process.env.UPLOAD_MINUTE_LIMIT = '1';
  assert.equal((await send(a, 'first.txt')).status, 201);
  const scanner = require('../utils/fileScanner');
  const crypto2 = require('../utils/crypto');
  const realScan = scanner.scanBuffer;
  const realEncrypt = crypto2.encryptFile;
  let scans = 0;
  let encrypts = 0;
  scanner.scanBuffer = (...args) => { scans += 1; return realScan(...args); };
  crypto2.encryptFile = (...args) => { encrypts += 1; return realEncrypt(...args); };
  try {
    const res = await send(a, 'second.txt');
    assert.equal(res.status, 429);
    assert.equal(scans, 0, 'scanBuffer not called');
    assert.equal(encrypts, 0, 'encryptFile not called');
  } finally {
    scanner.scanBuffer = realScan;
    crypto2.encryptFile = realEncrypt;
  }
});

it('refused uploads (a blocked file, a plain zip) still count against the budget', async () => {
  const a = await account('lim.refused@example.com');
  process.env.UPLOAD_MINUTE_LIMIT = '3';
  assert.equal((await send(a, 'harmless.txt', S.testSignature())).status, 422);
  assert.equal((await send(a, 'archive.zip', Buffer.from('PK\u0003\u0004 not really'))).status >= 400, true);
  assert.equal((await send(a, 'fine.txt')).status, 201);
  assert.equal((await send(a, 'over.txt')).status, 429, 'the fourth request is over a limit of 3');
  assert.equal((await bucketRow('docs-upload-minute', a)).count, 4);
});

it('a repeated uploadKey uses the budget again (every request is counted: the key is in the body, read after the check) but stores nothing more', async () => {
  const a = await account('lim.key@example.com');
  process.env.UPLOAD_MINUTE_LIMIT = '2';
  const key = crypto.randomUUID();
  assert.equal((await send(a, 'same.txt', Buffer.from('x'), { uploadKey: key })).status, 201);
  const again = await send(a, 'same.txt', Buffer.from('x'), { uploadKey: key });
  assert.equal(again.status, 200, 'the same upload again answers with the first one');
  assert.equal(await docCount(), 1);
  assert.equal((await bucketRow('docs-upload-minute', a)).count, 2, 'both requests counted');
  assert.equal((await send(a, 'third.txt', Buffer.from('y'), { uploadKey: crypto.randomUUID() })).status, 429);
});

it('only uploads to POST /api/documents are limited: listing and other routes are not', async () => {
  const a = await account('lim.other@example.com');
  process.env.UPLOAD_MINUTE_LIMIT = '1';
  assert.equal((await send(a, 'one.txt')).status, 201);
  assert.equal((await send(a, 'two.txt')).status, 429);
  assert.equal((await call('GET', D, { token: a.token })).status, 200);
  assert.equal((await call('GET', `${D}/storage`, { token: a.token })).status, 200);
});

it('the document cap blocks at the limit with 409 DOCUMENT_LIMIT and its plain sentence; Trash and held files count; new versions are not new documents', async () => {
  const a = await account('lim.cap@example.com');
  process.env.MAX_DOCUMENTS_PER_ACCOUNT = '4';
  const ids = [];
  for (const name of ['a.txt', 'b.txt']) ids.push((await send(a, name)).body.id);
  const heldRes = await send(a, 'held.pdf', S.pdfWith('/JavaScript'));
  assert.equal(heldRes.status, 201);
  const trashed = (await send(a, 'gone.txt')).body.id;
  assert.equal((await call('DELETE', `${D}/${trashed}`, { token: a.token })).status < 300, true, 'a file in Trash');
  assert.equal(await docCount(), 4, 'two live, one held, one in Trash');
  const refused = await send(a, 'extra.txt');
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.body.error.code, 'DOCUMENT_LIMIT');
  assert.equal(refused.body.error.message, 'You have reached the limit of 4 files. Delete some files or empty the Trash.');
  assert.equal(await docCount(), 4, 'nothing stored');
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('second contents')], { type: 'text/plain' }), 'a.txt');
  const version = await call('POST', `${D}/${ids[0]}/versions`, { token: a.token, form });
  assert.equal(version.status, 201, version.text);
  assert.equal(await docCount(), 4);
  const key = crypto.randomUUID();
  process.env.MAX_DOCUMENTS_PER_ACCOUNT = '5';
  assert.equal((await send(a, 'keyed.txt', Buffer.from('k'), { uploadKey: key })).status, 201);
  process.env.MAX_DOCUMENTS_PER_ACCOUNT = '5';
  assert.equal((await send(a, 'keyed.txt', Buffer.from('k'), { uploadKey: key })).status, 200);
  const b = await account('lim.cap.b@example.com');
  assert.equal((await send(b, 'mine.txt')).status, 201);
});

it('the count query is covered by an index (no collection scan)', async () => {
  const a = await account('lim.index@example.com');
  const plan = await live.mongoose.models.Document.collection.find({ userId: a.userId }).explain('queryPlanner');
  const text = JSON.stringify(plan.queryPlanner.winningPlan);
  assert.match(text, /IXSCAN/);
  assert.doesNotMatch(text, /COLLSCAN/);
});

it('each limit hit writes one security line: the event, a keyed hash, no email, token, address or file name', async () => {
  const a = await account('lim.log@example.com');
  process.env.UPLOAD_MINUTE_LIMIT = '1';
  process.env.MAX_DOCUMENTS_PER_ACCOUNT = '1';
  const lines = await logged(async () => {
    assert.equal((await send(a, 'secret-plan.txt')).status, 201);
    assert.equal((await send(a, 'secret-plan-2.txt')).status, 429);
    await live.mongoose.models.RateLimit.deleteMany({});
    assert.equal((await send(a, 'secret-plan-3.txt')).status, 409);
  });
  const rate = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((l) => l && l.type === 'rate_limited' && l.bucket === 'docs-upload-minute');
  const cap = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((l) => l && l.type === 'document_limit');
  assert.equal(rate.length, 1);
  assert.equal(cap.length, 1);
  for (const line of [...rate, ...cap]) assert.match(line.subject, /^[0-9a-f]{8}$/);
  const all = lines.join('\n');
  assert.doesNotMatch(all, /lim\.log|secret-plan|@example|Bearer|127\.0\.0\.1|::1/);
  assert.ok(!all.includes(a.token), 'no token');
  assert.ok(!all.includes(String(a.userId)), 'no account id');
});
