// Run with: cd server && npm test
//
// Forgot password around the emailed code: start -> code -> single-use ticket ->
// recovery key (vault kept) or start over (vault erased), plus "Try another way"
// (recovery key alone). Every model is an in-memory fake, so each test can look at
// every collection afterwards.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

delete process.env.OTP_ENABLED;
delete process.env.VERCEL;
for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']) delete process.env[name];
process.env.NODE_ENV = 'test';

const cryptoUtils = require('../utils/crypto');
const db = require('./helpers/fakeDb');

const world = db.createWorld();
db.installModels(world);
const budgets = db.installRateLimit();
db.installMailer(world);

const auth = require('../controllers/auth.controller');
const account = require('../controllers/account.controller');
const reset = require('../controllers/passwordReset.controller');
const { call } = db;

const PASSWORD = 'Tk9$Lantern-Orbit%57';
const NEW_PASSWORD = 'Wq4#Meadow-Cinder&81';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const GENERIC_CODE_FAILURE = 'That code is incorrect or has expired.';

function clearWorld() {
  for (const name of Object.keys(world.tables)) world.tables[name] = [];
  world.mails = [];
  budgets.clear();
}

/** A real account: a vault key wrapped under the password AND the recovery key, with a document and friends. */
function addUser(email, { verified = true } = {}) {
  const salt = cryptoUtils.generateSalt();
  const dek = cryptoUtils.generateDEK();
  const recoveryKey = cryptoUtils.generateRecoveryKey();
  const wrappedPassword = cryptoUtils.wrapKey(dek, cryptoUtils.deriveEncryptionKey(PASSWORD, salt));
  const recoveryKeyHash = cryptoUtils.hashRecoveryKey(recoveryKey);
  const wrappedRecovery = cryptoUtils.wrapKey(dek, cryptoUtils.deriveEncryptionKey(recoveryKey, recoveryKeyHash.split(':')[0]));
  const user = {
    _id: db.oid(),
    email,
    emailVerified: verified,
    salt,
    passwordHash: cryptoUtils.hashPassword(PASSWORD, salt),
    wrappedDEKPassword: wrappedPassword.wrappedKey,
    wrappedDEKPasswordIv: wrappedPassword.iv,
    wrappedDEKPasswordAuthTag: wrappedPassword.authTag,
    recoveryKeyHash,
    wrappedDEKRecovery: wrappedRecovery.wrappedKey,
    wrappedDEKRecoveryIv: wrappedRecovery.iv,
    wrappedDEKRecoveryAuthTag: wrappedRecovery.authTag,
    dekFingerprint: cryptoUtils.fingerprintDEK(dek),
    failedAttempts: 0,
    save: async () => {},
  };
  world.tables.users.push(user);
  return { user, dek, recoveryKey };
}

function addVaultStuff(userId) {
  const t = world.tables;
  t.documents.push({ _id: db.oid(), userId, filename: 'a.pdf', deletedAt: null }, { _id: db.oid(), userId, filename: 'trashed.pdf', deletedAt: new Date(), thumb: 'x' });
  t.folders.push({ _id: db.oid(), userId, name: 'Tax' });
  t.trashfolders.push({ _id: db.oid(), userId, name: 'Old' });
  t.shares.push({ _id: db.oid(), ownerUserId: userId });
  t.devices.push({ _id: db.oid(), userId, deviceIdHash: 'h', label: 'Chrome on Windows' });
  t.auditevents.push({ _id: db.oid(), userId, seq: 1, type: 'login', hash: 'x' });
  t.backuplogs.push({ _id: db.oid(), userId });
  t.trusteddevices.push({ _id: db.oid(), userId, tokenHash: 'h', expiresAt: new Date(Date.now() + 1e9) });
  t.sessions.push({ _id: db.oid(), userId, expiresAt: new Date(Date.now() + 1e9) });
}

const lastCode = () => world.mails.at(-1).text.match(/\b(\d{6})\b/)[1];
const start = (email, ip) => call(reset.startReset, { body: { email }, headers: { 'user-agent': UA }, ip });
const verify = (challengeToken, code) => call(reset.verifyResetCode, { body: { challengeToken, code } });

/** The whole happy path up to a ticket. */
async function ticketFor(email) {
  const s = await start(email);
  const v = await verify(s.json.challengeToken, lastCode());
  assert.ok(v.json?.resetTicket, 'a ticket');
  return v.json.resetTicket;
}
const withKey = (resetTicket, recoveryKey, newPassword = NEW_PASSWORD) =>
  call(reset.resetWithRecoveryKey, { body: { resetTicket, recoveryKey, newPassword }, headers: { 'user-agent': UA } });
const startOver = (resetTicket, confirmEmail, newPassword = NEW_PASSWORD) =>
  call(reset.resetWithWipe, { body: { resetTicket, confirmEmail, newPassword }, headers: { 'user-agent': UA } });
const keyOnly = (email, recoveryKey, newPassword = NEW_PASSWORD, ip = '203.0.113.50') =>
  call(reset.resetWithRecoveryKeyOnly, { body: { email, recoveryKey, newPassword }, headers: { 'user-agent': UA }, ip });

const shapeOf = (json) => Object.keys(json).sort().join(',');

// ---------------------------------------------------------------- screen 1

test('start: known, unknown, unverified and malformed addresses get the same answer; only the real one is mailed', async () => {
  clearWorld();
  addUser('ana@example.com');
  addUser('pending@example.com', { verified: false });

  const answers = {};
  for (const [label, email] of [
    ['known', 'ana@example.com'],
    ['unknown', 'nobody@example.com'],
    ['unverified', 'pending@example.com'],
    ['hostile', 'a,b@evil.com'],
    ['not an email', 'hello'],
  ]) {
    const before = world.mails.length;
    const out = await start(email);
    assert.equal(out.error, null, label);
    assert.equal(out.status, 200, label);
    answers[label] = out.json;
    assert.equal(world.mails.length - before, label === 'known' ? 1 : 0, `${label}: mailed only when real`);
  }
  for (const [label, json] of Object.entries(answers)) {
    assert.equal(json.message, "If an account exists for this address, we've sent a 6-digit code.", label);
    assert.equal(shapeOf(json), shapeOf(answers.known), `${label}: same fields as a real answer`);
    assert.equal(json.codeLength, 6);
    assert.equal(json.resendsLeft, 3);
    assert.match(json.challengeToken, /^[0-9a-f]{24}\.[0-9a-f]{64}$/);
  }
  assert.equal(world.mails[0].to, 'ana@example.com');
  assert.match(world.mails[0].subject, /Reset your Warden password/);

  for (const email of [undefined, null, 5, ['a@example.com'], { $ne: null }]) {
    assert.equal((await start(email)).error?.status, 400);
  }
});

test('start: the five-emails-an-hour account budget counts the same for an address with no account', async () => {
  clearWorld();
  addUser('ana@example.com');
  for (const email of ['ana@example.com', 'ghost@example.com']) {
    budgets.clear();
    const results = [];
    for (let i = 0; i < 6; i += 1) results.push((await start(email)).error?.status ?? 200);
    assert.deepEqual(results, [200, 200, 200, 200, 200, 429], email);
  }
});

test('start: an address with no account takes about as long as a real send', async () => {
  clearWorld();
  addUser('ana@example.com');
  world.sendDelayMs = 300;
  try {
    // the decoy's wait follows a smoothed average of recent real sends, so let it settle
    let real = 0;
    for (let i = 0; i < 8; i += 1) {
      budgets.clear();
      const t0 = Date.now();
      await start('ana@example.com');
      real = Date.now() - t0;
    }
    budgets.clear();
    const t = Date.now();
    await start('ghost@example.com');
    const decoy = Date.now() - t;
    assert.ok(real >= 280, `real ${real}ms`);
    assert.ok(decoy >= 200 && decoy <= 500, `decoy ${decoy}ms`);
  } finally {
    world.sendDelayMs = 0;
  }
});

// ---------------------------------------------------------------- screen 2

test('code: wrong, reused, expired and out-of-tries codes all fail with the same generic 401', async () => {
  clearWorld();
  addUser('ana@example.com');
  const s = await start('ana@example.com');
  const good = lastCode();
  const wrong = good === '000000' ? '111111' : '000000';

  const failures = [];
  for (let i = 0; i < 4; i += 1) failures.push((await verify(s.json.challengeToken, wrong)).error);
  assert.ok(failures.every((e) => e.status === 401 && e.message === GENERIC_CODE_FAILURE));
  // the 5th guess (even the right one) is the last: the challenge is gone afterwards
  assert.equal((await verify(s.json.challengeToken, wrong)).error.status, 401);
  assert.equal((await verify(s.json.challengeToken, good)).error.message, GENERIC_CODE_FAILURE, 'dead after 5 attempts');

  // correct once, then not again
  const s2 = await start('ana@example.com');
  const code2 = lastCode();
  assert.ok((await verify(s2.json.challengeToken, code2)).json.resetTicket);
  assert.equal((await verify(s2.json.challengeToken, code2)).error.message, GENERIC_CODE_FAILURE, 'single use');

  // expired
  const s3 = await start('ana@example.com');
  const code3 = lastCode();
  world.tables.otpchallenges.at(-1).expiresAt = new Date(Date.now() - 1000);
  assert.equal((await verify(s3.json.challengeToken, code3)).error.message, GENERIC_CODE_FAILURE);

  // malformed
  for (const token of [undefined, 'x', '1.2', 5, {}]) assert.equal((await verify(token, '123456')).error.status, 401);
});

test('code: an address with no account can never be verified, and fails like any wrong code', async () => {
  clearWorld();
  const s = await start('ghost@example.com');
  for (let i = 0; i < 6; i += 1) {
    const out = await verify(s.json.challengeToken, String(100000 + i));
    assert.equal(out.error.status, 401);
    assert.equal(out.error.message, GENERIC_CODE_FAILURE);
  }
  assert.equal(world.tables.resettickets.length, 0);
});

test('code: resend has a 60-second gap, 3 resends, and a decoy looks the same', async () => {
  for (const email of ['ana@example.com', 'ghost@example.com']) {
    clearWorld();
    addUser('ana@example.com');
    const s = await start(email);
    const early = await call(reset.resendResetCode, { body: { challengeToken: s.json.challengeToken } });
    assert.equal(early.error.status, 429, `${email}: too soon`);
    assert.ok(early.error.retryAfterSeconds > 0 && early.error.retryAfterSeconds <= 60);

    let token = s.json.challengeToken;
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      const row = world.tables.otpchallenges.at(-1);
      row.lastSentAt = new Date(Date.now() - 61 * 1000); // the minute has passed
      const out = await call(reset.resendResetCode, { body: { challengeToken: token } });
      results.push(out.error ? out.error.status : out.json.resendsLeft);
      if (!out.error) token = out.json.challengeToken;
    }
    assert.deepEqual(results, [2, 1, 0, 429], `${email}: 3 resends then no more`);
  }
});

test('code: a resent code replaces the old one, and the codes are only ever mailed to the owner', async () => {
  clearWorld();
  addUser('ana@example.com');
  const s = await start('ana@example.com');
  const first = lastCode();
  world.tables.otpchallenges.at(-1).lastSentAt = new Date(Date.now() - 61 * 1000);
  const r = await call(reset.resendResetCode, { body: { challengeToken: s.json.challengeToken } });
  const second = lastCode();
  assert.equal(world.mails.length, 2);
  if (first !== second) assert.equal((await verify(r.json.challengeToken, first)).error?.status, 401, 'the previous code stops working');
  assert.ok((await verify(r.json.challengeToken, second)).json.resetTicket);
});

test('purposes are separate: a login or deletion code cannot be used here, and a reset code cannot log in or delete', async () => {
  clearWorld();
  const { user } = addUser('ana@example.com');

  // a LOGIN code presented to the reset verifier
  const login = await call(auth.unlock, { body: { email: user.email, password: PASSWORD }, headers: { 'user-agent': UA } });
  assert.equal(login.json.otpRequired, true);
  const loginCode = lastCode();
  assert.equal((await verify(login.json.challengeToken, loginCode)).error.message, GENERIC_CODE_FAILURE);

  // a DELETE-ACCOUNT code presented to the reset verifier
  const del = await call(account.deleteChallenge, { userId: user._id, body: { password: PASSWORD } });
  const delCode = lastCode();
  assert.equal((await verify(del.json.challengeToken, delCode)).error.message, GENERIC_CODE_FAILURE);

  // a RESET code presented to login and to deletion
  const s = await start(user.email);
  const resetCode = lastCode();
  assert.equal((await call(auth.verifyOtp, { body: { challengeToken: s.json.challengeToken, code: resetCode } })).error.status, 401);
  assert.equal(
    (await call(account.deleteAccount, { userId: user._id, body: { challengeToken: s.json.challengeToken, code: resetCode, emailConfirmation: user.email } })).error.status,
    401
  );
  assert.equal(world.tables.sessions.length, 0, 'no session was ever issued');
  // ...and it still works for what it is for
  assert.ok((await verify(s.json.challengeToken, resetCode)).json.resetTicket);
});

// ---------------------------------------------------------------- the ticket

test('ticket: random, stored only as a hash, tied to the user, 10 minutes, never a session or a key', async () => {
  clearWorld();
  const { user, dek } = addUser('ana@example.com');
  const s = await start(user.email);
  const v = await verify(s.json.challengeToken, lastCode());

  assert.deepEqual(Object.keys(v.json).sort(), ['expiresAt', 'resetTicket']);
  const ticket = v.json.resetTicket;
  assert.ok(ticket.length >= 40);
  const stored = world.tables.resettickets;
  assert.equal(stored.length, 1);
  assert.equal(String(stored[0].userId), String(user._id));
  assert.notEqual(stored[0].tokenHash, ticket);
  assert.ok(!JSON.stringify(world.tables).includes(ticket), 'the raw ticket is stored nowhere');
  assert.ok(!JSON.stringify(v.json).includes(dek.toString('hex')) && !JSON.stringify(v.json).includes(dek.toString('base64')));
  const ttl = new Date(v.json.expiresAt) - Date.now();
  assert.ok(ttl > 9.8 * 60 * 1000 && ttl <= 10 * 60 * 1000);
  assert.equal(world.tables.sessions.length, 0);
  assert.equal(world.tables.otpchallenges.length, 0, 'the code is consumed');

  // a newer ticket replaces the older one
  const newer = await ticketFor(user.email);
  assert.equal(world.tables.resettickets.length, 1);
  assert.equal((await withKey(ticket, 'AAAA-AAAA-AAAA-AAAA')).error.code, 'RESET_TICKET_INVALID');
  assert.notEqual(newer, ticket);
});

test('ticket: expired, malformed and foreign tickets are refused with one generic error', async () => {
  clearWorld();
  const { user, recoveryKey } = addUser('ana@example.com');
  const ticket = await ticketFor(user.email);
  world.tables.resettickets[0].expiresAt = new Date(Date.now() - 1000);
  for (const t of [ticket, 'nope', '', undefined, 12345, 'x'.repeat(500)]) {
    const a = await withKey(t, recoveryKey);
    const b = await startOver(t, user.email);
    for (const out of [a, b]) {
      assert.equal(out.error.status, 401);
      assert.equal(out.error.code, 'RESET_TICKET_INVALID');
    }
  }
  assert.equal(world.tables.users[0].passwordHash, user.passwordHash, 'nothing changed');
});

// ---------------------------------------------------------------- option A

test('option A: the right recovery key (any spacing and case) keeps the vault; after login the vault key is unchanged', async () => {
  clearWorld();
  const { user, dek, recoveryKey } = addUser('ana@example.com');
  addVaultStuff(user._id);
  const documentsBefore = JSON.stringify(world.tables.documents);
  const oldHash = user.passwordHash;

  const ticket = await ticketFor(user.email);
  const sloppy = recoveryKey.toLowerCase().replace(/-/g, '  ');
  const out = await withKey(ticket, `  ${sloppy} `);
  assert.equal(out.error, null);
  assert.equal(out.status, 200);
  assert.deepEqual(Object.keys(out.json).sort(), ['message', 'success'], 'no session, no key in the answer');

  assert.equal(JSON.stringify(world.tables.documents), documentsBefore, 'documents untouched');
  assert.equal(world.tables.folders.length, 1);
  assert.notEqual(user.passwordHash, oldHash);
  assert.equal(user.dekFingerprint, cryptoUtils.fingerprintDEK(dek), 'same vault key');
  // the new password unwraps the SAME vault key; the old one no longer logs in
  const reopened = cryptoUtils.unwrapKey(
    user.wrappedDEKPassword,
    cryptoUtils.deriveEncryptionKey(NEW_PASSWORD, user.salt),
    user.wrappedDEKPasswordIv,
    user.wrappedDEKPasswordAuthTag
  );
  assert.ok(reopened.equals(dek));
  assert.ok(!cryptoUtils.verifyPassword(PASSWORD, user.salt, user.passwordHash));
  // not logged in; the next login still needs the emailed code
  world.mails = [];
  const login = await call(auth.unlock, { body: { email: user.email, password: NEW_PASSWORD }, headers: { 'user-agent': UA } });
  assert.equal(login.json.otpRequired, true);
  assert.equal(login.json.sessionToken, undefined);
  // and the same recovery key still works afterwards
  assert.ok(cryptoUtils.verifyRecoveryKey(recoveryKey, user.recoveryKeyHash));
});

test('option A: a wrong key changes nothing, counts against the ticket, and the 5th miss kills it', async () => {
  clearWorld();
  const { user, recoveryKey } = addUser('ana@example.com');
  addVaultStuff(user._id);
  const snapshot = JSON.stringify({ ...user, save: undefined });
  const ticket = await ticketFor(user.email);

  const errors = [];
  for (let i = 0; i < 4; i += 1) errors.push((await withKey(ticket, 'ABCD-EFGH-JKMN-PQRS')).error);
  for (const e of errors) {
    assert.equal(e.status, 401);
    assert.equal(e.message, 'That recovery key is incorrect. Nothing was changed.');
    assert.equal(e.code, undefined);
  }
  assert.equal(world.tables.resettickets[0].attempts, 4);
  const fifth = await withKey(ticket, 'not even shaped like a key');
  assert.equal(fifth.error.code, 'RESET_TICKET_INVALID', 'the 5th wrong key ends the ticket');
  assert.equal(world.tables.resettickets.length, 0);
  assert.equal((await withKey(ticket, recoveryKey)).error.code, 'RESET_TICKET_INVALID', 'even the right key is too late');
  assert.equal(JSON.stringify({ ...user, save: undefined }), snapshot, 'nothing changed');
  assert.equal(world.tables.documents.length, 2);
});

test('option A: a weak password is a form error and does not burn an attempt; the ticket is single use', async () => {
  clearWorld();
  const { user, recoveryKey } = addUser('ana@example.com');
  const ticket = await ticketFor(user.email);
  const weak = await withKey(ticket, recoveryKey, 'short');
  assert.equal(weak.error.status, 400);
  assert.ok(Array.isArray(weak.error.errors));
  assert.equal(world.tables.resettickets[0].attempts, 0);
  assert.equal((await withKey(ticket, recoveryKey)).status, 200);
  assert.equal((await withKey(ticket, recoveryKey, 'Another#Strong-Pass92')).error.code, 'RESET_TICKET_INVALID', 'spent');
});

// ---------------------------------------------------------------- option B

test('option B: confirmation email required; the vault is wiped; a NEW recovery key is shown once; the old key is dead', async () => {
  clearWorld();
  const { user, recoveryKey: oldKey } = addUser('ana@example.com');
  addVaultStuff(user._id);
  const other = addUser('ben@example.com');
  addVaultStuff(other.user._id);
  const ticket = await ticketFor(user.email);

  const mismatch = await startOver(ticket, 'someone@else.com');
  assert.equal(mismatch.error.status, 400);
  assert.equal(world.tables.documents.length, 4, 'nothing wiped on a mismatch');
  assert.equal(world.tables.resettickets.length, 1, 'and the ticket is still usable');

  const out = await startOver(ticket, '  ANA@example.com ');
  assert.equal(out.error, null);
  assert.equal(out.json.documentsWiped, true);
  assert.match(out.json.recoveryKey, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  assert.notEqual(out.json.recoveryKey, oldKey);
  assert.equal(out.json.sessionToken, undefined);

  const mine = (rows) => rows.filter((r) => String(r.userId ?? r.ownerUserId) === String(user._id));
  for (const table of ['documents', 'folders', 'trashfolders', 'shares', 'devices', 'backuplogs', 'trusteddevices', 'sessions', 'resettickets']) {
    assert.equal(mine(world.tables[table]).length, 0, `${table}: zero rows`);
  }
  // The old log went with the vault; the only event is the new chain's first one: the password change itself.
  assert.deepEqual(mine(world.tables.auditevents).map((e) => [e.seq, e.type]), [[1, 'password_changed']], 'a fresh activity log');
  const bens = (rows) => rows.filter((r) => String(r.userId ?? r.ownerUserId) === String(other.user._id));
  assert.equal(bens(world.tables.documents).length, 2, "ben's vault is untouched");
  assert.equal(bens(world.tables.shares).length, 1);

  // new vault key, new recovery key; the old recovery key opens nothing
  assert.ok(cryptoUtils.verifyRecoveryKey(out.json.recoveryKey, user.recoveryKeyHash));
  assert.ok(!cryptoUtils.verifyRecoveryKey(oldKey, user.recoveryKeyHash));
  assert.ok(cryptoUtils.verifyPassword(NEW_PASSWORD, user.salt, user.passwordHash));
  const old = await keyOnly(user.email, oldKey, 'Zx9$Quarry-Lantern44');
  assert.equal(old.error.status, 401, 'the old key no longer works');
  assert.equal(world.tables.documents.filter((d) => String(d.userId) === String(user._id)).length, 0);
  // and the new one does
  budgets.clear();
  assert.equal((await keyOnly(user.email, out.json.recoveryKey, 'Zx9$Quarry-Lantern44')).status, 200);
});

// ---------------------------------------------------------------- Try another way

test('try another way: the right key resets and keeps the vault, no emailed code involved', async () => {
  clearWorld();
  const { user, dek, recoveryKey } = addUser('ana@example.com');
  addVaultStuff(user._id);
  const out = await keyOnly(' Ana@Example.com ', recoveryKey.toLowerCase());
  assert.equal(out.error, null);
  assert.deepEqual(Object.keys(out.json).sort(), ['message', 'success']);
  assert.equal(world.tables.documents.length, 2);
  assert.equal(user.dekFingerprint, cryptoUtils.fingerprintDEK(dek));
  assert.ok(cryptoUtils.verifyPassword(NEW_PASSWORD, user.salt, user.passwordHash));
  assert.equal(world.tables.otpchallenges.length, 0);
});

test('try another way: wrong key, unknown email, unverified account and junk all fail with the identical error', async () => {
  clearWorld();
  const { user, recoveryKey } = addUser('ana@example.com');
  addUser('pending@example.com', { verified: false });
  const other = addUser('ben@example.com');
  const cases = [
    ['wrong key', user.email, 'ABCD-EFGH-JKMN-PQRS'],
    ["somebody else's key", user.email, other.recoveryKey],
    ['unknown email', 'ghost@example.com', recoveryKey],
    ['unverified', 'pending@example.com', recoveryKey],
    ['junk key', user.email, 'hello'],
    ['empty key', user.email, ''],
  ];
  const seen = new Set();
  for (const [label, email, key] of cases) {
    budgets.clear();
    const out = await keyOnly(email, key);
    assert.equal(out.error?.status, 401, label);
    seen.add(`${out.error.status}|${out.error.message}|${out.error.code}`);
  }
  assert.deepEqual([...seen], ['401|The email or recovery key is incorrect.|undefined']);
  assert.equal(world.mails.length, 0, 'nothing is mailed for failures');
  assert.ok(cryptoUtils.verifyPassword(PASSWORD, user.salt, user.passwordHash), 'nothing changed');
});

test('try another way: failures lock with growing delays, and an IP is limited across emails', async () => {
  clearWorld();
  const { user, recoveryKey } = addUser('ana@example.com');
  const wrong = 'ABCD-EFGH-JKMN-PQRS';

  // first miss: an immediate retry is held back (and says for how long); the right key is held back too
  assert.equal((await keyOnly(user.email, wrong)).error.status, 401);
  const held = await keyOnly(user.email, recoveryKey);
  assert.equal(held.error.status, 429);
  assert.ok(held.error.retryAfterSeconds > 0);
  assert.equal(held.error.message, 'Too many attempts. Please try again later.');
  // the same message and shape for an address that does not exist
  assert.equal((await keyOnly('ghost@example.com', wrong)).error.status, 401);
  assert.equal((await keyOnly('ghost@example.com', wrong)).error.status, 429);

  // the tiers: 10 s, 2 min, 10 min, 1 h
  const names = reset.KEY_ONLY_EMAIL_BUDGETS.map((b) => `${b.name}:${b.max}:${b.windowMs}`);
  assert.deepEqual(names, ['rk-gap-10s:1:10000', 'rk-gap-2m:2:120000', 'rk-gap-10m:3:600000', 'rk-fail-1h:5:3600000']);
  assert.equal(reset.KEY_ONLY_EMAIL_BUDGETS.at(-1).max, 5, '5 failures an hour per email');

  // per IP: 10 failures an hour across different emails, then even a right key is refused from that IP
  budgets.clear();
  const ip = '198.51.100.77';
  for (let i = 0; i < 10; i += 1) assert.equal((await keyOnly(`n${i}@example.com`, wrong, NEW_PASSWORD, ip)).error.status, 401);
  assert.equal((await keyOnly(user.email, recoveryKey, NEW_PASSWORD, ip)).error.status, 429);
  assert.equal((await keyOnly(user.email, recoveryKey, NEW_PASSWORD, '198.51.100.78')).status, 200, 'another IP is not affected');
});

test('try another way: the notification email has the time and browser, no IP, no link, no token', async () => {
  clearWorld();
  const { user, recoveryKey } = addUser('ana@example.com');
  await keyOnly(user.email, recoveryKey, NEW_PASSWORD, '203.0.113.200');
  const mail = world.mails.at(-1);
  assert.equal(mail.to, 'ana@example.com');
  assert.match(mail.subject, /password was changed/i);
  assert.match(mail.text, /changed using your recovery key/);
  assert.match(mail.text, /If this wasn't you/);
  assert.match(mail.text, /Browser: Chrome on Windows/);
  assert.match(mail.text, /When: .* Philippine Time \(UTC\+8\)/);
  assert.doesNotMatch(mail.text, /https?:|www\.|\/reset|token/i, 'no links, no tokens');
  assert.doesNotMatch(mail.text, /203\.0\.113\.200/, 'no IP address');
  assert.doesNotMatch(mail.text, new RegExp(recoveryKey), 'never the key');
});

// ------------------------------------------------------- after ANY reset

test('after every reset type: sessions and trusted browsers are gone, pending tickets and codes die, nobody is logged in', async () => {
  const makers = {
    'option A': async (u) => withKey(await ticketFor(u.user.email), u.recoveryKey),
    'option B': async (u) => startOver(await ticketFor(u.user.email), u.user.email),
    'try another way': async (u) => keyOnly(u.user.email, u.recoveryKey),
  };
  for (const [label, run] of Object.entries(makers)) {
    clearWorld();
    const u = addUser('ana@example.com');
    const ben = addUser('ben@example.com');
    addVaultStuff(u.user._id);
    addVaultStuff(ben.user._id);
    // pending things that must die: a login code, a delete code, a reset code, and a second ticket's worth of state
    await call(auth.unlock, { body: { email: u.user.email, password: PASSWORD }, headers: { 'user-agent': UA } });
    await start(u.user.email);
    const pending = world.tables.otpchallenges.filter((c) => String(c.userId) === String(u.user._id)).length;
    assert.ok(pending >= 2, label);
    const stale = await ticketFor(u.user.email);
    await start(u.user.email); // another code in flight

    const out = await run(u);
    assert.equal(out.error, null, label);
    assert.equal(out.json.sessionToken, undefined, `${label}: no session handed out`);
    const mine = (rows) => rows.filter((r) => String(r.userId) === String(u.user._id));
    assert.equal(mine(world.tables.sessions).length, 0, `${label}: sessions revoked`);
    assert.equal(mine(world.tables.trusteddevices).length, 0, `${label}: trusted browsers revoked`);
    assert.equal(mine(world.tables.otpchallenges).length, 0, `${label}: codes dropped`);
    assert.equal(mine(world.tables.resettickets).length, 0, `${label}: tickets dropped`);
    assert.equal((await withKey(stale, u.recoveryKey, 'Another#Strong-Pass92')).error.code, 'RESET_TICKET_INVALID', `${label}: the old ticket fails`);
    // another account is untouched
    assert.equal(world.tables.sessions.filter((r) => String(r.userId) === String(ben.user._id)).length, 1, label);
    assert.equal(world.tables.trusteddevices.filter((r) => String(r.userId) === String(ben.user._id)).length, 1, label);
    // the old password is dead; the new one only gets as far as the emailed code
    assert.equal((await call(auth.unlock, { body: { email: u.user.email, password: PASSWORD }, headers: {} })).error.status, 401, `${label}: old password`);
    budgets.clear(); // an hour later: the per-account email budget has reset
    const login = await call(auth.unlock, { body: { email: u.user.email, password: NEW_PASSWORD }, headers: {} });
    assert.equal(login.json.otpRequired, true, `${label}: new password still needs the code`);
    assert.equal(login.json.sessionToken, undefined);
    // the owner was told
    assert.ok(world.mails.some((m) => /password was changed/i.test(m.subject)), `${label}: notified`);
    // the trusted-browser cookie of THIS browser is cleared
    assert.ok(out.cleared.some((name) => /^warden_td_[0-9a-f]{16}$/.test(name)) && out.cleared.includes('warden_td'), `${label}: cookie cleared`);
  }
});

// ------------------------------------------------------- emails, logs, removal

test('emails: codes only in code emails; no reset links anywhere in the codebase or the mail', async () => {
  clearWorld();
  const { user, recoveryKey } = addUser('ana@example.com');
  await start(user.email);
  const codeMail = world.mails.at(-1);
  assert.match(codeMail.text, /\b\d{6}\b/);
  assert.doesNotMatch(codeMail.text, /https?:|\/reset-password|token/i);
  await keyOnly(user.email, recoveryKey);
  assert.doesNotMatch(world.mails.at(-1).text, /\b\d{6}\b/, 'the notification carries no code');

  const root = path.join(__dirname, '..');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'test') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(root);
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (path.basename(file) === 'auth.routes.js') continue; // the 410 handlers are named there
    assert.doesNotMatch(source, /reset-password\?token|resetTokenHash|resetTokenExpiresAt/, path.relative(root, file));
  }
  assert.equal(require('../models/User').schema?.path?.('resetTokenHash'), undefined);
});

test('removed flow: the old endpoints answer 410 and never look anything up', async () => {
  clearWorld();
  addUser('ana@example.com');
  for (const body of [{ email: 'ana@example.com' }, { token: 'abc', newPassword: NEW_PASSWORD, recoveryKey: 'x' }, {}]) {
    const out = await call(reset.goneResetLink, { body });
    assert.equal(out.status, 410);
    assert.deepEqual(Object.keys(out.json.error), ['message']);
    assert.doesNotMatch(out.json.error.message, /expired|invalid|token|exist/i, 'says nothing about the old token or the account');
  }
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.routes.js'), 'utf8');
  assert.match(routes, /'\/forgot-password', goneResetLink/);
  assert.match(routes, /'\/reset-password', goneResetLink/);
});

test('logs: tickets, codes, keys and passwords are never printed', async () => {
  clearWorld();
  const { user, recoveryKey } = addUser('ana@example.com');
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = console.warn = console.error = console.info = (...args) => lines.push(args.map(String).join(' '));
  let ticket;
  let code;
  try {
    const s = await start(user.email);
    code = lastCode();
    ticket = (await verify(s.json.challengeToken, code)).json.resetTicket;
    await withKey(ticket, 'ABCD-EFGH-JKMN-PQRS');
    await withKey(ticket, recoveryKey);
    await keyOnly(user.email, 'ABCD-EFGH-JKMN-PQRS');
  } finally {
    Object.assign(console, original);
  }
  const output = lines.join('\n');
  for (const secret of [ticket, code, recoveryKey, NEW_PASSWORD, PASSWORD]) assert.ok(!output.includes(secret), 'a secret was logged');
});

test('normalizeRecoveryKey forgives spaces, dashes and case - and nothing else', () => {
  const key = cryptoUtils.generateRecoveryKey();
  for (const form of [key, key.toLowerCase(), key.replace(/-/g, ' '), key.replace(/-/g, ''), `  ${key.toLowerCase().replace(/-/g, ' - ')}\n`]) {
    assert.equal(cryptoUtils.normalizeRecoveryKey(form), key);
  }
  for (const bad of ['', 'ABCD-EFGH-JKMN', `${key}X`, key.replace(/.$/, '0'), key.replace(/.$/, 'O'), 12, null, 'x'.repeat(200)]) {
    assert.equal(cryptoUtils.normalizeRecoveryKey(bad), null, String(bad));
  }
});
