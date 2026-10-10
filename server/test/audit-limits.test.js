// Run with: cd server && npm test
//
// What the activity log's hash chain can and cannot do, shown against a REAL local MongoDB (test/helpers/realMongo.js).
// The site says the check "detects edits and gaps" and "cannot detect the removal of the newest entries by someone who
// can write to the database". This test keeps those words true:
//   - an edited event is detected;
//   - a gap in the middle is detected;
//   - deleting the newest events WITHOUT moving the head is detected;
//   - deleting the newest events AND moving the head back to match is NOT detected (a known limit, needs no key).
// If an external anchor for the head is ever added, the last case should start failing, and the wording on the site
// (pages/public/*, DevicesPage, DEPLOY.md) can then be strengthened.
const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.VERCEL;
process.env.NODE_ENV = 'test';

const { connectThrowaway, disconnectThrowaway, mongoose } = require('./helpers/realMongo');
const User = require('../models/User');
const AuditEvent = require('../models/AuditEvent');
const { appendEvent, verifyChain } = require('../utils/audit');

let connected = { ok: false, reason: '' };
test.before(async () => {
  connected = await connectThrowaway('audit_limits');
  if (connected.ok) {
    await User.init();
    await AuditEvent.init();
  }
});
test.after(disconnectThrowaway);

const it = (name, fn) =>
  test(name, async (context) => {
    if (!connected.ok) return context.skip(connected.reason);
    return fn(context);
  });

async function account() {
  await mongoose.connection.dropDatabase();
  await User.init();
  await AuditEvent.init();
  const user = await User.create({
    email: 'a@example.com', passwordHash: 'x', salt: 'x', recoveryKeyHash: 'x', wrappedDEKPassword: 'x', wrappedDEKPasswordIv: 'x',
    wrappedDEKPasswordAuthTag: 'x', wrappedDEKRecovery: 'x', wrappedDEKRecoveryIv: 'x', wrappedDEKRecoveryAuthTag: 'x', dekFingerprint: 'x',
  });
  for (const type of ['login', 'view', 'download', 'emergency_session_started', 'emergency_file_viewed']) {
    await appendEvent({ userId: user._id, type, actor: type.startsWith('emergency') ? 'emergency' : null });
  }
  return user;
}

it('an intact log verifies', async () => {
  const user = await account();
  const result = await verifyChain(user._id);
  assert.equal(result.ok, true);
  assert.equal(result.checked, 5);
});

it('an edited event is detected', async () => {
  const user = await account();
  await AuditEvent.updateOne({ userId: user._id, seq: 2 }, { $set: { type: 'logout' } });
  const result = await verifyChain(user._id);
  assert.equal(result.ok, false);
  assert.equal(result.brokenAtSeq, 2);
});

it('a gap in the middle is detected', async () => {
  const user = await account();
  await AuditEvent.deleteOne({ userId: user._id, seq: 3 });
  assert.equal((await verifyChain(user._id)).ok, false);
});

it('deleting the newest events while leaving the head alone is detected', async () => {
  const user = await account();
  await AuditEvent.deleteMany({ userId: user._id, seq: { $gte: 4 } });
  assert.equal((await verifyChain(user._id)).ok, false);
});

it('KNOWN LIMIT: deleting the newest events and moving the head back to match is not detected', async () => {
  const user = await account();
  await AuditEvent.deleteMany({ userId: user._id, seq: { $gte: 4 } });
  const newest = await AuditEvent.findOne({ userId: user._id }).sort({ seq: -1 });
  await User.updateOne({ _id: user._id }, { $set: { auditHead: { seq: newest.seq, hash: newest.hash, at: newest.at } } });
  const result = await verifyChain(user._id);
  assert.equal(result.ok, true, 'this is why the wording says the removal of the newest entries cannot be detected');
  assert.equal(result.checked, 3);
});
