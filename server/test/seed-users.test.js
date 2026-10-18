const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCsv, readUsers, mapRow, parseArgs, DB_NAME } = require('../scripts/seed-users');

test('the CSV reader keeps commas, doubled quotes and line breaks inside quoted fields', () => {
  const rows = parseCsv('a,b\r\n"x, y","say ""hi"""\n"two\nlines",z\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', 'z']]);
});

test('readUsers keys each row by the header and keeps UserID as text', () => {
  const [user] = readUsers('UserID,Name,Interests\n000123,"Doe, Jane","a, b"\n');
  assert.equal(user.UserID, '000123');
  assert.equal(user.Interests, 'a, b');
});

test('mapRow makes a shell account: fake email, seed tag, reminders off, nothing personal', () => {
  const doc = mapRow({ UserID: '000123', Name: 'Jane', Gender: 'F', DOB: '1990-01-01', City: 'Manila' }, 7);
  assert.equal(doc.email, 'u000123@seed.invalid');
  assert.deepEqual(doc.seed, { source: 'kaggle-socialmedia-users', row: 7 });
  assert.equal(doc.expiryReminders, false);
  const text = JSON.stringify(doc);
  for (const personal of ['Jane', 'Manila', '1990-01-01']) assert.ok(!text.includes(personal));
});

test('mapRow secrets are random, differ per account and have the real shapes', () => {
  const a = mapRow({ UserID: '1' }, 1);
  const b = mapRow({ UserID: '2' }, 2);
  assert.notEqual(a.passwordHash, b.passwordHash);
  assert.match(a.passwordHash, /^[0-9a-f]{128}$/);
  assert.match(a.salt, /^[0-9a-f]{32}$/);
  assert.match(a.recoveryKeyHash, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.equal(Buffer.from(a.wrappedDEKPassword, 'base64').length, 32);
  assert.equal(Buffer.from(a.wrappedDEKPasswordIv, 'base64').length, 12);
  assert.equal(Buffer.from(a.wrappedDEKPasswordAuthTag, 'base64').length, 16);
  assert.match(a.dekFingerprint, /^[0-9a-f]{64}$/);
});

test('the script is pinned to the warden_seed database and has safe defaults', () => {
  assert.equal(DB_NAME, 'warden_seed');
  assert.deepEqual(parseArgs([]), { limit: 1000, batch: 500, pauseMs: 1500, dryRun: false, dropSeed: false, dropDb: false });
  assert.throws(() => parseArgs(['--nope']));
});
