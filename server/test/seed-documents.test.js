const test = require('node:test');
const assert = require('node:assert/strict');

const {
  planTiers, makeRecords, makeRng, TIERS, EXTENSIONS, MAX_FILE, MAX_ACCOUNT_BYTES, MAX_ACCOUNT_RECORDS,
} = require('../scripts/seed-documents');

test('the same rng seed gives the same plan; another seed gives a different one', () => {
  const a = planTiers({ users: 5000, rngSeed: 42 });
  const b = planTiers({ users: 5000, rngSeed: 42 });
  const c = planTiers({ users: 5000, rngSeed: 43 });
  assert.deepEqual(a.accounts, b.accounts);
  assert.notDeepEqual(a.accounts, c.accounts);
});

test('tier shares are within 1 percentage point of the weights', () => {
  const plan = planTiers({ users: 100000, rngSeed: 42 });
  for (const [tier, spec] of Object.entries(TIERS)) {
    assert.ok(Math.abs(plan.accountsPerTier[tier] / 100000 - spec.weight) < 0.01, tier);
  }
  const total = Object.values(plan.accountsPerTier).reduce((a, b) => a + b, 0);
  assert.equal(total, 100000);
  assert.ok(plan.expectedRecords > 45000 && plan.expectedRecords < 65000, `expected about 55,000, got ${plan.expectedRecords}`);
});

test('every account stays under 25 MB, 4 MB per file and 2,000 records', () => {
  const plan = planTiers({ users: 20000, rngSeed: 7 });
  const rng = makeRng(99);
  for (const { tier, count } of plan.accounts.filter((a) => a.count > 0)) {
    const records = makeRecords({ userId: 'u', tier, count, rng });
    assert.ok(records.length <= MAX_ACCOUNT_RECORDS);
    assert.ok(records.reduce((sum, r) => sum + r.simulatedSize, 0) <= MAX_ACCOUNT_BYTES);
    for (const r of records) assert.ok(r.simulatedSize <= MAX_FILE && r.simulatedSize >= 20 * 1024);
  }
});

test('a full account claims about 20 to 25 MB over 150 to 300 records', () => {
  const rng = makeRng(5);
  const records = makeRecords({ userId: 'u', tier: 'full', count: 200, rng });
  const total = records.reduce((sum, r) => sum + r.simulatedSize, 0);
  assert.ok(total >= 19 * 1024 * 1024 && total <= MAX_ACCOUNT_BYTES, `total ${total}`);
});

test('every record has the seed tag, no file bytes, a unique name and an allowed extension', () => {
  const records = makeRecords({ userId: 'u', tier: 'heavy', count: 60, rng: makeRng(1), rngSeed: 42 });
  const names = new Set();
  for (const r of records) {
    assert.deepEqual(r.seed, { source: 'simulated-documents', rngSeed: 42 });
    assert.equal(r.encryptedBlob.length, 0);
    assert.equal(r.folder, 'root');
    assert.ok(EXTENSIONS.includes(r.filename.split('.').pop()), r.filename);
    assert.ok(!names.has(r.filename));
    names.add(r.filename);
  }
});
