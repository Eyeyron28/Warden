// Run with: cd server && npm test   (Node's built-in test runner, no deps)
//
// Self-serve account deletion and the "no session without the emailed code"
// rule. Every model is an in-memory fake installed BEFORE the controllers
// load, so the tests can look at every collection after each step.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']) delete process.env[name];
delete process.env.OTP_ENABLED;
delete process.env.VERCEL;
process.env.NODE_ENV = 'test';

const cryptoUtils = require('../utils/crypto');

function stub(modulePath, exportsObject) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObject };
}

// ---------- fake models ----------
const oid = () => new mongoose.Types.ObjectId();
const isId = (v) => v instanceof mongoose.Types.ObjectId;
const matchValue = (actual, cond) => {
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !isId(cond)) {
    if ('$in' in cond) return cond.$in.map(String).includes(String(actual));
    if ('$lt' in cond && !(actual < cond.$lt)) return false;
    if ('$lte' in cond && !(actual <= cond.$lte)) return false;
    if ('$gt' in cond && !(actual > cond.$gt)) return false;
    if ('$gte' in cond && !(actual >= cond.$gte)) return false;
    return true;
  }
  if (actual instanceof Date && cond instanceof Date) return actual.getTime() === cond.getTime();
  return String(actual) === String(cond);
};
const matches = (doc, filter) =>
  Object.entries(filter).every(([key, cond]) =>
    key === '$or' ? cond.some((alternative) => matches(doc, alternative)) : matchValue(doc[key], cond)
  );

const NAMES = [
  'users', 'documents', 'folders', 'backuplogs', 'paireddevices', 'pairingtokens',
  'recoveryrequesttokens', 'shares', 'sharedfiles', 'shareaccess', 'sessions', 'otpchallenges', 'ratelimits', 'trashfolders', 'trusteddevices', 'resettickets',
];
const world = { mails: [], tables: Object.fromEntries(NAMES.map((n) => [n, []])), fail: null };

function fakeModel(name) {
  const rows = () => world.tables[name];
  const query = (result) => {
    const q = { select: () => q, session: () => q, sort: () => q, then: (ok, bad) => Promise.resolve(result()).then(ok, bad) };
    return q;
  };
  return {
    create: async (doc) => {
      const created = { _id: oid(), attempts: 0, resendCount: 0, ...doc };
      rows().push(created);
      return created;
    },
    find: (filter) => query(() => rows().filter((r) => matches(r, filter))),
    findOne: async (filter) => rows().find((r) => matches(r, filter)) || null,
    findById: async (id) => rows().find((r) => String(r._id) === String(id)) || null,
    findOneAndUpdate: async (filter, update, options) => {
      const doc = rows().find((r) => matches(r, filter));
      if (!doc) return null;
      for (const [key, amount] of Object.entries(update.$inc || {})) doc[key] += amount;
      Object.assign(doc, update.$set || {});
      return options?.new ? doc : { ...doc };
    },
    findOneAndDelete: async (filter) => {
      const index = rows().findIndex((r) => matches(r, filter));
      return index === -1 ? null : rows().splice(index, 1)[0];
    },
    deleteOne: async (filter) => {
      const index = rows().findIndex((r) => matches(r, filter));
      if (index !== -1) rows().splice(index, 1);
      return { deletedCount: index === -1 ? 0 : 1 };
    },
    deleteMany: async (filter) => {
      if (world.fail === name) {
        world.fail = null;
        throw new Error(`injected failure while deleting ${name}`);
      }
      const keep = rows().filter((r) => !matches(r, filter));
      const deletedCount = rows().length - keep.length;
      world.tables[name] = keep;
      return { deletedCount };
    },
  };
}

const models = {
  User: 'users', Document: 'documents', Folder: 'folders', BackupLog: 'backuplogs', PairedDevice: 'paireddevices',
  PairingToken: 'pairingtokens', RecoveryRequestToken: 'recoveryrequesttokens', Share: 'shares',
  SharedFile: 'sharedfiles', ShareAccess: 'shareaccess', Session: 'sessions', OtpChallenge: 'otpchallenges', RateLimit: 'ratelimits', TrashFolder: 'trashfolders', TrustedDevice: 'trusteddevices', ResetTicket: 'resettickets',
};
for (const [modelName, table] of Object.entries(models)) stub(`../models/${modelName}`, fakeModel(table));

// A transaction that really rolls back: snapshot every table, restore on error.
stub('../utils/folders', {
  runInTransaction: async (fn) => {
    const snapshot = Object.fromEntries(Object.entries(world.tables).map(([k, v]) => [k, [...v]]));
    try {
      return await fn(null);
    } catch (err) {
      world.tables = snapshot;
      throw err;
    }
  },
});
const budget = new Map();
stub('../middleware/rateLimit', {
  consumeBudget: async ({ name, key, max }) => {
    const id = `${name}:${key}`;
    budget.set(id, (budget.get(id) || 0) + 1);
    return budget.get(id) <= max;
  },
});
const realEmail = require('../utils/email');
stub('../utils/email', {
  ...realEmail,
  sendEmail: async (message) => {
    world.mails.push(message);
    return true;
  },
});
const sessions = [];
stub('../utils/sessionStore', {
  createSession: async (userId, dek) => {
    const token = `session-${sessions.length + 1}`;
    sessions.push({ token, userId, dek });
    return token;
  },
  destroySession: async () => {},
  destroyAllSessionsForUser: async () => {},
});

const { unlock, verifyOtp, recoverViaPhoneInit } = require('../controllers/auth.controller');
const { deleteChallenge, resendDeleteCode, deleteAccount } = require('../controllers/account.controller');
const { deleteAccountData } = require('../utils/accountDeletion');

// ---------- helpers ----------
const PASSWORD = 'Tk9$Lantern-Orbit%57';

function addUser(email) {
  const salt = cryptoUtils.generateSalt();
  const dek = cryptoUtils.generateDEK();
  const wrapped = cryptoUtils.wrapKey(dek, cryptoUtils.deriveEncryptionKey(PASSWORD, salt));
  const user = {
    _id: oid(), email, emailVerified: true, salt, dek,
    passwordHash: cryptoUtils.hashPassword(PASSWORD, salt),
    wrappedDEKPassword: wrapped.wrappedKey, wrappedDEKPasswordIv: wrapped.iv, wrappedDEKPasswordAuthTag: wrapped.authTag,
    failedAttempts: 0, save: async () => {},
  };
  world.tables.users.push(user);
  return user;
}

// A user with a row in every collection that holds user data.
function populate(user) {
  const t = world.tables;
  const shareId = crypto.randomBytes(16).toString('hex');
  t.documents.push({ _id: oid(), userId: user._id, filename: 'passport.png', encryptedBlob: Buffer.alloc(10), thumbCipher: Buffer.alloc(4) });
  t.documents.push({ _id: oid(), userId: user._id, filename: 'lease.pdf', encryptedBlob: Buffer.alloc(10) });
  t.folders.push({ _id: oid(), userId: user._id, name: 'Taxes' });
  // Things in Trash: a file trashed on its own, and a trashed folder with a file inside it.
  const batchId = crypto.randomBytes(16).toString('hex');
  t.documents.push({ _id: oid(), userId: user._id, filename: 'old.pdf', encryptedBlob: Buffer.alloc(10), thumbCipher: Buffer.alloc(4), deletedAt: new Date(), purgeAt: new Date(Date.now() + 86400000), trashBatchId: null });
  t.documents.push({ _id: oid(), userId: user._id, filename: 'in-folder.png', folder: 'Old', encryptedBlob: Buffer.alloc(10), thumbCipher: Buffer.alloc(4), deletedAt: new Date(), purgeAt: new Date(Date.now() + 86400000), trashBatchId: batchId });
  t.trashfolders.push({ _id: oid(), userId: user._id, batchId, path: 'Old', parentPath: '', name: 'Old', subPaths: ['Old'], itemCount: 1 });
  t.backuplogs.push({ _id: oid(), userId: user._id });
  t.paireddevices.push({ _id: oid(), userId: user._id, deviceToken: 'dev' });
  t.pairingtokens.push({ _id: oid(), userId: user._id });
  t.recoveryrequesttokens.push({ _id: oid(), userId: user._id });
  // A share with every protection on, and everything that hangs off it.
  t.shares.push({
    _id: oid(), ownerUserId: user._id, shareId, sourceDocumentIds: [],
    recipientEmail: 'recipient@example.com', downloadCount: 2, maxDownloads: 5,
    passwordSalt: 'c2FsdA==', passwordWrappedKey: 'd3JhcHBlZA==', passwordVerifierHash: 'ab'.repeat(32),
  });
  t.sharedfiles.push({ _id: oid(), shareId, fileId: 'f1' });
  t.shareaccess.push({ _id: oid(), shareId, tokenHash: 'cd'.repeat(32), emailOk: true, passwordOk: true });
  // The emailed-code challenge for a visitor of that share (userId is the share's owner).
  t.otpchallenges.push({ _id: oid(), userId: user._id, purpose: 'share-email', shareId, accessId: 'a1' });
  t.ratelimits.push({ _id: oid(), bucket: 'share-password', key: shareId });
  t.ratelimits.push({ _id: oid(), bucket: 'share-email', key: shareId });
  t.sessions.push({ _id: oid(), userId: user._id });
  t.trusteddevices.push({ _id: oid(), userId: user._id, tokenHash: 'ef'.repeat(32), label: 'Chrome on Windows' });
  t.ratelimits.push({ _id: oid(), bucket: 'otp-email-account', key: String(user._id) });
  t.ratelimits.push({ _id: oid(), bucket: 'signup-email', key: user.email });
  t.ratelimits.push({ _id: oid(), bucket: 'login', key: '203.0.113.7' }); // an IP: cannot be tied to a person
}

const countsFor = () => Object.fromEntries(NAMES.map((n) => [n, world.tables[n].length]));
const rowsOwnedBy = (user) => {
  const id = String(user._id);
  const json = JSON.stringify(world.tables, (key, value) => (value && value.type === 'Buffer' ? '[bytes]' : value));
  const shareIds = world.tables.shares.filter((r) => String(r.ownerUserId) === id).map((r) => r.shareId);
  return {
    // Includes the recipient email, the wrapped key and verifier hash that only exist inside a share.
    stringHits: json.includes(id) || json.includes(user.email) || shareIds.length > 0,
    byOwner: ['documents', 'folders', 'trashfolders', 'backuplogs', 'paireddevices', 'pairingtokens', 'recoveryrequesttokens', 'sessions', 'otpchallenges', 'trusteddevices']
      .reduce((n, name) => n + world.tables[name].filter((r) => String(r.userId) === id).length, 0)
      + world.tables.shares.filter((r) => String(r.ownerUserId) === id).length,
  };
};

function reset() {
  world.mails = [];
  world.tables = Object.fromEntries(NAMES.map((n) => [n, []]));
  world.fail = null;
  budget.clear();
  sessions.length = 0;
}

async function call(handler, { userId, body = {} } = {}) {
  const out = { status: null, json: null, error: null };
  const res = {
    status(code) { out.status = code; return this; },
    json(payload) { out.json = payload; return this; },
    clearCookie(name) { (out.cleared ||= []).push(name); return this; },
  };
  await handler({ userId, body, dek: null }, res, (err) => { out.error = err; });
  return out;
}
const lastCode = () => /code is (\d{6})\./.exec(world.mails[world.mails.length - 1].text)[1];
const GENERIC = 'That code is incorrect or has expired.';

async function readyToDelete(user) {
  const r = await call(deleteChallenge, { userId: user._id, body: { password: PASSWORD } });
  assert.equal(r.error, null);
  return { token: r.json.challengeToken, code: lastCode() };
}

// ---------- tests ----------
test('delete-challenge re-checks the password with the login lockout and sends nothing on failure', async () => {
  reset();
  const user = addUser('ana@example.com');
  for (let i = 0; i < 2; i += 1) {
    const bad = await call(deleteChallenge, { userId: user._id, body: { password: 'Wrong-Password-1!' } });
    assert.equal(bad.error.status, 401);
    assert.equal(bad.error.message, 'Incorrect email or password.');
  }
  const locked = await call(deleteChallenge, { userId: user._id, body: { password: 'Wrong-Password-1!' } });
  assert.equal(locked.error.status, 403, 'the 3rd failure locks the account');
  assert.equal(world.mails.length, 0);
  assert.equal(world.tables.otpchallenges.length, 0);
  assert.equal((await call(deleteChallenge, { userId: user._id, body: {} })).error.status, 400);
});

test('the delete code is for deletion only and does not touch the vault key', async () => {
  reset();
  const user = addUser('ana@example.com');
  const { token } = await readyToDelete(user);
  const challenge = world.tables.otpchallenges[0];
  assert.equal(challenge.purpose, 'delete-account');
  assert.match(world.mails[0].subject, /deletion code/i);
  assert.match(world.mails[0].text, /ignore this email/i);
  const unwrapped = cryptoUtils.unwrapKey(challenge.wrappedDek, Buffer.from(token.split('.')[1], 'hex'), challenge.wrappedDekIv, challenge.wrappedDekAuthTag);
  assert.equal(unwrapped.length, 32);
  assert.ok(!unwrapped.equals(user.dek), 'what the challenge wraps is not the vault key');
  assert.ok(!JSON.stringify(challenge).includes(user.dek.toString('hex')));
});

test('a login code cannot authorise deletion, and a delete code cannot log in', async () => {
  reset();
  const user = addUser('ana@example.com');
  populate(user);

  const login = await call(unlock, { body: { email: 'ana@example.com', password: PASSWORD } });
  const loginCode = lastCode();
  const attack = await call(deleteAccount, {
    userId: user._id,
    body: { challengeToken: login.json.challengeToken, code: loginCode, emailConfirmation: 'ana@example.com' },
  });
  assert.equal(attack.error.status, 401);
  assert.equal(attack.error.message, GENERIC);
  assert.equal(world.tables.documents.length, 4, 'nothing deleted');
  assert.equal(world.tables.users.length, 1);
  // ...and the login challenge was not harmed: it still completes the login.
  const ok = await call(verifyOtp, { body: { challengeToken: login.json.challengeToken, code: loginCode } });
  assert.equal(ok.json.sessionToken, 'session-1');

  const del = await readyToDelete(user);
  const reverse = await call(verifyOtp, { body: { challengeToken: del.token, code: del.code } });
  assert.equal(reverse.error.status, 401);
  assert.equal(reverse.error.message, GENERIC);
  assert.equal(sessions.length, 1, 'no session was issued by a delete code');
  // ...and the delete challenge still works for deletion.
  const real = await call(deleteAccount, { userId: user._id, body: { challengeToken: del.token, code: del.code, emailConfirmation: 'ana@example.com' } });
  assert.equal(real.status, 200);
  assert.deepEqual(real.cleared, ['warden_td'], 'the trusted-browser cookie is cleared with the account');
});

test("another account's delete challenge cannot be used, even with the right code and key", async () => {
  reset();
  const ana = addUser('ana@example.com');
  const ben = addUser('ben@example.com');
  populate(ana);
  populate(ben);
  const anas = await readyToDelete(ana);
  const attack = await call(deleteAccount, {
    userId: ben._id,
    body: { challengeToken: anas.token, code: anas.code, emailConfirmation: 'ben@example.com' },
  });
  assert.equal(attack.error.status, 401);
  assert.equal(world.tables.users.length, 2);
  assert.equal(rowsOwnedBy(ben).byOwner, 14, 'ben untouched');
});

test('wrong password, wrong code and wrong email confirmation each fail and delete nothing', async () => {
  reset();
  const user = addUser('ana@example.com');
  populate(user);
  const before = countsFor();

  const wrongPw = await call(deleteChallenge, { userId: user._id, body: { password: 'Nope-Nope-1!' } });
  assert.equal(wrongPw.error.status, 401);

  const { token, code } = await readyToDelete(user);
  const wrongEmail = await call(deleteAccount, { userId: user._id, body: { challengeToken: token, code, emailConfirmation: 'ben@example.com' } });
  assert.equal(wrongEmail.error.status, 400);
  assert.equal(world.tables.otpchallenges.find((c) => c.purpose === 'delete-account').attempts, 0, 'a typo in the email does not burn a code attempt');
  const wrongCode = await call(deleteAccount, {
    userId: user._id,
    body: { challengeToken: token, code: code === '000000' ? '000001' : '000000', emailConfirmation: 'ana@example.com' },
  });
  assert.equal(wrongCode.error.status, 401);
  assert.equal(wrongCode.error.message, GENERIC);
  for (const bad of [{}, { challengeToken: token }, { challengeToken: token, code }, { challengeToken: 5, code, emailConfirmation: 'ana@example.com' }]) {
    assert.equal((await call(deleteAccount, { userId: user._id, body: bad })).error.status, 400);
  }
  const after = countsFor();
  for (const name of NAMES.filter((n) => n !== 'otpchallenges')) assert.equal(after[name], before[name], `${name} unchanged`);
  assert.equal(world.mails.length, 1, 'only the code email; no deletion confirmation');
});

test('deleting removes every row for the account, leaves other accounts alone, and confirms by email', async () => {
  reset();
  const ana = addUser('ana@example.com');
  const ben = addUser('ben@example.com');
  populate(ana);
  populate(ben);
  const benBefore = JSON.stringify(world.tables, (k, v) => (v && v.type === 'Buffer' ? '[b]' : v));
  const anaBefore = countsFor();

  const { token, code } = await readyToDelete(ana);
  const result = await call(deleteAccount, {
    userId: ana._id,
    body: { challengeToken: token, code, emailConfirmation: '  ANA@example.com ' },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { success: true });

  const left = rowsOwnedBy(ana);
  assert.equal(left.byOwner, 0, 'no row owned by the user');
  assert.equal(left.stringHits, false, 'the id and the email appear nowhere in any collection');
  assert.equal(world.tables.users.length, 1);
  assert.equal(world.tables.ratelimits.filter((r) => r.key === '203.0.113.7').length, 2, 'IP-keyed rows are not about a person and stay');
  // Ben's rows are exactly as before (compare after removing the rows that were ana's).
  assert.equal(rowsOwnedBy(ben).byOwner, 14);
  assert.ok(world.tables.sharedfiles.length === 1 && world.tables.shares.length === 1, "only ben's share and its copy remain");
  assert.ok(benBefore.length > 0 && anaBefore.documents === 8);

  const mail = world.mails[world.mails.length - 1];
  assert.equal(mail.to, 'ana@example.com');
  assert.match(mail.subject, /deleted/i);
  assert.match(mail.text, /permanently deleted/);
  assert.ok(!/code is \d{6}/.test(mail.text));
});

test('a mid-way failure rolls everything back, and the deletion can simply be run again', async () => {
  reset();
  const ana = addUser('ana@example.com');
  populate(ana);
  const before = countsFor();

  world.fail = 'folders'; // blow up after documents were already removed inside the transaction
  const first = await readyToDelete(ana);
  const failed = await call(deleteAccount, { userId: ana._id, body: { challengeToken: first.token, code: first.code, emailConfirmation: 'ana@example.com' } });
  assert.equal(failed.error.status, 500);
  assert.match(failed.error.message, /try again/i);
  const afterFailure = countsFor();
  for (const name of NAMES.filter((n) => n !== 'otpchallenges')) assert.equal(afterFailure[name], before[name], `${name} rolled back`);
  assert.ok(!world.mails.some((m) => /has been deleted/.test(m.subject)), 'no confirmation for a deletion that did not finish');

  const second = await readyToDelete(ana);
  const done = await call(deleteAccount, { userId: ana._id, body: { challengeToken: second.token, code: second.code, emailConfirmation: 'ana@example.com' } });
  assert.equal(done.status, 200);
  assert.equal(rowsOwnedBy(ana).stringHits, false);
});

test('without a transaction the order revokes access first and a retry finishes the job', async () => {
  reset();
  const ana = addUser('ana@example.com');
  populate(ana);

  world.fail = 'backuplogs'; // stops after shares, devices, tokens, sessions, documents and folders are gone
  await assert.rejects(deleteAccountData(ana._id, { email: ana.email, transaction: false }), /injected failure/);
  assert.equal(world.tables.shares.length, 0, 'share links already dead');
  assert.equal(world.tables.sharedfiles.length, 0);
  assert.equal(world.tables.paireddevices.length, 0);
  assert.equal(world.tables.sessions.length, 0, 'every bearer token already dead');
  assert.equal(world.tables.documents.length, 0, 'no ciphertext left');
  assert.equal(world.tables.users.length, 1, 'the account itself goes last');

  const counts = await deleteAccountData(ana._id, { email: ana.email, transaction: false });
  assert.equal(world.tables.users.length, 0);
  assert.equal(counts.backuplogs, 1);
  assert.equal(rowsOwnedBy(ana).stringHits, false);
  // Running it yet again is harmless.
  const again = await deleteAccountData(ana._id, { email: ana.email, transaction: false });
  assert.ok(Object.values(again).every((n) => n === 0));
});

test('an interrupted deletion that already removed the user is finished by calling the endpoint again', async () => {
  reset();
  const ana = addUser('ana@example.com');
  populate(ana);
  world.tables.users = []; // the account is gone but some rows linger
  const result = await call(deleteAccount, { userId: ana._id, body: { challengeToken: 'x', code: '123456', emailConfirmation: 'ana@example.com' } });
  assert.equal(result.status, 200);
  assert.equal(rowsOwnedBy(ana).byOwner, 0);
});

test('resending the delete code works for its owner only and keeps its purpose', async () => {
  reset();
  const ana = addUser('ana@example.com');
  const ben = addUser('ben@example.com');
  const { token } = await readyToDelete(ana);
  world.tables.otpchallenges[0].lastSentAt = new Date(Date.now() - 61000);
  const stolen = await call(resendDeleteCode, { userId: ben._id, body: { challengeToken: token } });
  assert.equal(stolen.error.status, 401);
  const ok = await call(resendDeleteCode, { userId: ana._id, body: { challengeToken: token } });
  assert.equal(ok.status, 200);
  assert.match(world.mails[world.mails.length - 1].subject, /deletion code/i);
  assert.equal(world.tables.otpchallenges[0].purpose, 'delete-account');
});

test('starting a phone recovery works and links to the validated public origin', async () => {
  reset();
  const ana = addUser('ana@example.com');
  process.env.PUBLIC_APP_URL = 'https://warden.example.com';
  try {
    const known = await call(recoverViaPhoneInit, { body: { email: 'ana@example.com' } });
    assert.equal(known.error, null);
    assert.equal(known.status, 201);
    assert.match(known.json.recoveryToken, /^[0-9a-f]{64}$/);
    assert.equal(known.json.recoverUrl, `https://warden.example.com/phone?recover=${known.json.recoveryToken}`);
    assert.equal(world.tables.recoveryrequesttokens.length, 1);
    assert.equal(String(world.tables.recoveryrequesttokens[0].userId), String(ana._id));

    const unknown = await call(recoverViaPhoneInit, { body: { email: 'nobody@example.com' } });
    assert.equal(unknown.status, 201, 'an unknown email gets the same shape of answer');
    assert.deepEqual(Object.keys(unknown.json).sort(), Object.keys(known.json).sort());
    assert.equal(world.tables.recoveryrequesttokens.length, 1, '...but no token is created');
  } finally {
    delete process.env.PUBLIC_APP_URL;
  }
});

test('no route can issue a session without the emailed code', () => {
  const dir = path.join(__dirname, '..');
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const reset = strip(fs.readFileSync(path.join(dir, 'utils', 'accountReset.js'), 'utf8'));
  const wipe = reset.slice(reset.indexOf('async function wipeVault'), reset.indexOf('const NOTICES'));
  assert.match(wipe, /removeShares\(\{ ownerUserId: userId \}\)/, 'the wipe removes shares, their wrapped keys, verifiers, recipient emails, counters and code challenges');
  assert.doesNotMatch(wipe, /SharedFile|Share\.deleteMany/, 'no ad-hoc partial cleanup left in the wipe');
  assert.match(wipe, /Document\.deleteMany\(\{ userId \}\)/, 'the wipe deletes every document, trashed ones included (no deletedAt filter)');
  assert.match(wipe, /TrashFolder\.deleteMany\(\{ userId \}\)/, 'and the trashed-folder entries');
  const deletion = strip(fs.readFileSync(path.join(dir, 'utils', 'accountDeletion.js'), 'utf8'));
  assert.match(deletion, /removeShares\(\{ ownerUserId: userId \}/);
  const cleanup = strip(fs.readFileSync(path.join(dir, 'utils', 'shareCleanup.js'), 'utf8'));
  for (const model of ['SharedFile', 'ShareAccess', 'OtpChallenge', 'RateLimit', 'Share']) {
    assert.match(cleanup, new RegExp(model), `${model} is cleaned with the share`);
  }
});
