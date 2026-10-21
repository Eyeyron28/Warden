#!/usr/bin/env node
/* eslint-disable no-console */

const crypto = require('crypto');
const { mkdirSync, writeFileSync } = require('fs');
const path = require('path');

const { connect, DB_NAME } = require('./seed-users');

const COLLECTION = 'documents';
const USERS = 'users';
const USER_SOURCE = 'kaggle-socialmedia-users';
const DOC_SOURCE = 'simulated-documents';
const REPORT_PATH = path.join(__dirname, 'out', 'seed-documents-report.md');

const MB = 1024 * 1024;
const KB = 1024;
const MAX_FILE = 4 * MB;
const MIN_FILE = 20 * KB;
const MAX_ACCOUNT_BYTES = 25 * MB;
const MAX_ACCOUNT_RECORDS = 2000;
const DAY = 24 * 60 * 60 * 1000;

const TIERS = {
  none: { weight: 0.7218, min: 0, max: 0 },
  light: { weight: 0.24, min: 1, max: 3 },
  medium: { weight: 0.035, min: 4, max: 12 },
  heavy: { weight: 0.003, min: 13, max: 60 },
  full: { weight: 0.0002, min: 150, max: 300, minBytes: 20 * MB, maxBytes: 25 * MB },
};
const TIER_NAMES = Object.keys(TIERS);

const EXTENSIONS = ['pdf', 'docx', 'xlsx', 'jpg', 'png', 'txt', 'zip'];
const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  jpg: 'image/jpeg',
  png: 'image/png',
  txt: 'text/plain',
  zip: 'application/zip',
};
const EXTENSION_WEIGHTS = [30, 15, 10, 20, 12, 8, 5];
const TITLES = [
  'Passport scan', 'Lease agreement', 'Tax return', 'Bank statement', 'Insurance policy', 'Medical results',
  'Receipt', 'Invoice', 'Meeting notes', 'Project plan', 'Resume', 'Certificate', 'Utility bill', 'Contract',
  'Vacation photo', 'Family photo', 'Budget', 'Warranty', 'School records', 'Vehicle registration',
  'Permit', 'Application form', 'Reference letter', 'Scanned page', 'Backup copy', 'Draft',
];

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));
const pick = (rng, list) => list[Math.floor(rng() * list.length)];

function shuffle(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function tierCounts(users) {
  const raw = TIER_NAMES.map((name) => ({ name, exact: TIERS[name].weight * users }));
  const counts = Object.fromEntries(raw.map((r) => [r.name, Math.floor(r.exact)]));
  let left = users - Object.values(counts).reduce((a, b) => a + b, 0);
  for (const r of raw.slice().sort((a, b) => (b.exact % 1) - (a.exact % 1))) {
    if (left <= 0) break;
    counts[r.name] += 1;
    left -= 1;
  }
  return counts;
}

function planTiers({ users, rngSeed = 42 }) {
  const rng = makeRng(rngSeed);
  const counts = tierCounts(users);
  const tiers = [];
  for (const name of TIER_NAMES) for (let i = 0; i < counts[name]; i += 1) tiers.push(name);
  const accounts = shuffle(tiers, rng).map((tier) => {
    const spec = TIERS[tier];
    return { tier, count: spec.max === 0 ? 0 : randInt(rng, spec.min, spec.max) };
  });
  const expectedRecords = accounts.reduce((sum, a) => sum + a.count, 0);
  return { rngSeed, users, accountsPerTier: counts, expectedRecords, accounts };
}

function sampleSize(rng) {
  const u1 = Math.max(rng(), 1e-12);
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rng());
  return Math.min(MAX_FILE, Math.max(MIN_FILE, Math.round(Math.exp(Math.log(120 * KB) + 1.1 * z))));
}

function fitTotal(sizes, target) {
  let out = sizes.slice();
  for (let pass = 0; pass < 6; pass += 1) {
    const sum = out.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - target) < 1024) break;
    const factor = target / sum;
    out = out.map((s) => Math.min(MAX_FILE, Math.max(MIN_FILE, Math.round(s * factor))));
  }
  return out;
}

function pickExtension(rng) {
  let roll = rng() * EXTENSION_WEIGHTS.reduce((a, b) => a + b, 0);
  for (let i = 0; i < EXTENSIONS.length; i += 1) {
    roll -= EXTENSION_WEIGHTS[i];
    if (roll < 0) return EXTENSIONS[i];
  }
  return EXTENSIONS[0];
}

const b64 = (bytes) => crypto.randomBytes(bytes).toString('base64');

function makeRecords({ userId, tier, count, rng, now = new Date(), rngSeed = 42 }) {
  if (count <= 0) return [];
  const n = Math.min(count, MAX_ACCOUNT_RECORDS);
  let sizes = Array.from({ length: n }, () => sampleSize(rng));
  const spec = TIERS[tier];
  if (spec && spec.minBytes) sizes = fitTotal(sizes, randInt(rng, spec.minBytes, spec.maxBytes));
  if (sizes.reduce((a, b) => a + b, 0) > MAX_ACCOUNT_BYTES) sizes = fitTotal(sizes, MAX_ACCOUNT_BYTES);

  const used = new Set();
  return sizes.map((size) => {
    const ext = pickExtension(rng);
    const base = `${pick(rng, TITLES)} ${randInt(rng, 2019, 2026)}`;
    let filename = `${base}.${ext}`;
    for (let copy = 2; used.has(filename); copy += 1) filename = `${base} (${copy}).${ext}`;
    used.add(filename);

    const createdAt = new Date(now.getTime() - Math.floor(rng() * 180 * DAY));
    let docExpiresAt = null;
    if (rng() < 0.15) {
      const days = rng() < 0.25 ? randInt(rng, 0, 7) : randInt(rng, 8, 700);
      const day = new Date(now.getTime() + days * DAY);
      docExpiresAt = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
    }
    return {
      userId,
      filename,
      folder: 'root',
      encryptedBlob: Buffer.alloc(0),
      iv: b64(12),
      authTag: b64(16),
      checksum: crypto.randomBytes(32).toString('hex'),
      mimeType: MIME[ext],
      originDevice: rng() < 0.7 ? 'pc' : 'phone',
      docExpiresAt,
      sniffedType: null,
      previewKind: null,
      thumbFailedAt: null,
      thumbFailReason: null,
      lastOpenedAt: null,
      viewCount: 0,
      downloadCount: 0,
      starred: false,
      hasNote: false,
      versionCounter: 0,
      deletedAt: null,
      purgeAt: null,
      trashBatchId: null,
      syncStatus: 'synced',
      createdAt,
      updatedAt: createdAt,
      simulatedSize: size,
      seed: { source: DOC_SOURCE, rngSeed },
    };
  });
}

function parseArgs(argv) {
  const opts = {
    users: 100000, limitUsers: null, batch: 1000, pauseMs: 1500, rngSeed: 42, maxClusterMb: 280, dryRun: false, dropDocs: false,
  };
  const number = (flag, value) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} needs a whole number`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--users') opts.users = number(flag, argv[++i]);
    else if (flag === '--limit-users') opts.limitUsers = number(flag, argv[++i]);
    else if (flag === '--batch') opts.batch = Math.max(1, number(flag, argv[++i]));
    else if (flag === '--pause-ms') opts.pauseMs = number(flag, argv[++i]);
    else if (flag === '--rng-seed') opts.rngSeed = number(flag, argv[++i]);
    else if (flag === '--max-cluster-mb') opts.maxClusterMb = number(flag, argv[++i]);
    else if (flag === '--dry-run') opts.dryRun = true;
    else if (flag === '--drop-docs') opts.dropDocs = true;
    else throw new Error(`Unknown option ${flag}`);
  }
  return opts;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function printPlan(plan) {
  console.log(`Plan for ${plan.users} accounts (rng seed ${plan.rngSeed}):`);
  for (const name of TIER_NAMES) {
    const spec = TIERS[name];
    const range = spec.max === 0 ? 'no records' : `${spec.min} to ${spec.max} records each`;
    console.log(`  ${name.padEnd(7)} ${String(plan.accountsPerTier[name]).padStart(7)} accounts  (${range})`);
  }
  console.log(`  expected records: ${plan.expectedRecords}`);
}

const printable = (doc) => JSON.stringify(doc, (key, value) => (key === 'encryptedBlob' ? '<empty Buffer, 0 bytes>' : value), 2);

const SYSTEM_DATABASES = ['local', 'config', 'admin'];

function databasesToCount(names) {
  return names.filter((name) => !SYSTEM_DATABASES.includes(name));
}

async function clusterBytes(mongoose) {
  const client = mongoose.connection.getClient();
  let listed;
  try {
    listed = await client.db('admin').admin().listDatabases();
  } catch (error) {
    throw new Error(`Cannot list databases (${error.message}). The size budget cannot be checked, so the run is aborted.`);
  }
  const counted = [];
  let total = 0;
  for (const name of databasesToCount(listed.databases.map((entry) => entry.name))) {
    let stats;
    try {
      stats = await client.db(name).command({ dbStats: 1 });
    } catch (error) {
      throw new Error(`Cannot read the size of database "${name}" (${error.message}). The size budget cannot be checked, so the run is aborted.`);
    }
    counted.push(name);
    total += (stats.dataSize || 0) + (stats.indexSize || 0);
  }
  return { total, counted };
}

async function ensureIndexes(collection) {
  const { schema } = require('../models/Document');
  for (const [fields, options] of schema.indexes()) {
    const { background, ...rest } = options || {};
    void background;
    await collection.createIndex(fields, rest);
  }
}

async function timeQueries(collection, owners, rng) {
  const quotas = { light: 70, medium: 70, heavy: 50, full: 10 };
  const chosen = [];
  for (const [tier, quota] of Object.entries(quotas)) {
    chosen.push(...shuffle(owners.filter((o) => o.tier === tier), rng).slice(0, quota));
  }
  const pool = shuffle(owners, rng);
  for (const owner of pool) {
    if (chosen.length >= 200) break;
    if (!chosen.includes(owner)) chosen.push(owner);
  }
  const times = [];
  const explains = [];
  for (const owner of chosen.slice(0, 200)) {
    const pipeline = [
      { $match: { userId: owner.id, deletedAt: null, 'quarantine.state': { $ne: 'held' } } },
      { $sort: { createdAt: -1 } },
      { $project: { filename: 1, folder: 1, docExpiresAt: 1, createdAt: 1, mimeType: 1, size: { $binarySize: '$encryptedBlob' } } },
    ];
    const started = process.hrtime.bigint();
    await collection.aggregate(pipeline).toArray();
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
    explains.push(summarizeExplain(await collection.aggregate(pipeline).explain('executionStats')));
  }
  times.sort((a, b) => a - b);
  const at = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
  const plans = [...new Set(explains.map((e) => e.plan))];
  return {
    count: times.length,
    median: at(0.5),
    p95: at(0.95),
    serverMedianMs: medianOf(explains.map((e) => e.millis)),
    plans,
    medianExamined: medianOf(explains.map((e) => e.examined)),
    medianReturned: medianOf(explains.map((e) => e.returned)),
  };
}

function summarizeExplain(explain) {
  const cursor = explain.stages?.[0]?.$cursor;
  const stats = explain.executionStats ?? cursor?.executionStats ?? {};
  const planned = explain.queryPlanner ?? cursor?.queryPlanner ?? {};
  const names = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.stage === 'string') names.push(node.stage);
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  };
  walk(planned.winningPlan);
  return {
    millis: stats.executionTimeMillis ?? null,
    plan: names.includes('IXSCAN') ? 'IXSCAN' : names.includes('COLLSCAN') ? 'COLLSCAN' : 'unknown',
    examined: stats.totalDocsExamined ?? null,
    returned: stats.nReturned ?? null,
  };
}

const medianOf = (values) => {
  const sorted = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

const mb = (bytes) => `${(bytes / MB).toFixed(1)} MB`;

async function run(opts) {
  const mongoose = await connect();
  const db = mongoose.connection.db;
  const documents = db.collection(COLLECTION);
  const report = [];
  try {
    if ((await documents.countDocuments({ 'seed.source': DOC_SOURCE })) > 0) {
      throw new Error('Simulated documents already exist. Run --drop-docs first so a re-run does not double them.');
    }
    const ids = (await db.collection(USERS).find({ 'seed.source': USER_SOURCE }, { projection: { _id: 1 } }).toArray()).map((u) => u._id);
    if (ids.length === 0) throw new Error(`No seeded accounts found in ${DB_NAME}.${USERS}. Run seed-users.js first.`);

    const plan = planTiers({ users: ids.length, rngSeed: opts.rngSeed });
    printPlan(plan);
    const shuffled = shuffle(ids, makeRng(opts.rngSeed ^ 0x9e3779b9));
    const owners = shuffled.slice(0, opts.limitUsers ?? shuffled.length).map((id, i) => ({ id, ...plan.accounts[i] }));

    await ensureIndexes(documents);
    const { total: before, counted } = await clusterBytes(mongoose);
    const limitBytes = opts.maxClusterMb * MB;
    console.log(`Databases counted: ${counted.join(', ')}`);
    console.log(`Cluster size before: ${mb(before)} (limit ${opts.maxClusterMb} MB)`);

    const rng = makeRng(opts.rngSeed + 7);
    const now = new Date();
    const started = Date.now();
    let inserted = 0;
    let stoppedByBudget = false;
    let stopReason = '';
    const withRecords = [];
    const { calculateObjectSize } = require('bson');

    let position = 0;
    while (position < owners.length) {
      const batch = [];
      while (position < owners.length && batch.length < opts.batch) {
        const owner = owners[position];
        position += 1;
        const records = makeRecords({ userId: owner.id, tier: owner.tier, count: owner.count, rng, now, rngSeed: opts.rngSeed });
        if (records.length) withRecords.push(owner);
        batch.push(...records);
      }
      if (batch.length === 0) continue;
      const estimate = batch.reduce((sum, doc) => sum + calculateObjectSize(doc), 0) * 2;
      const { total: current } = await clusterBytes(mongoose);
      if (current + estimate > limitBytes) {
        stoppedByBudget = true;
        stopReason = `Cluster at ${mb(current)} plus about ${mb(estimate)} for the next batch is above ${opts.maxClusterMb} MB.`;
        console.log(`Stopping: ${stopReason}`);
        break;
      }
      const result = await documents.insertMany(batch, { ordered: false });
      inserted += result.insertedCount;
      console.log(`Inserted ${inserted} records (${position} of ${owners.length} accounts processed)`);
      if (position < owners.length) await sleep(opts.pauseMs);
    }
    const seconds = (Date.now() - started) / 1000;

    const stats = await db.command({ collStats: COLLECTION }).catch(() => null);
    const { total: after } = await clusterBytes(mongoose);
    const timings = withRecords.length ? await timeQueries(documents, withRecords, makeRng(opts.rngSeed + 99)) : null;

    report.push(
      '# Simulated documents report',
      '',
      `- Records inserted: ${inserted} (${seconds.toFixed(1)} s)`,
      `- Accounts per tier (plan): ${TIER_NAMES.map((n) => `${n} ${plan.accountsPerTier[n]}`).join(', ')}`,
      `- Accounts processed: ${position} of ${owners.length}`,
      stats ? `- Average bytes per record: ${(stats.size / Math.max(1, stats.count)).toFixed(0)}` : '- Collection stats not available',
      stats ? `- dataSize: ${stats.size} bytes, indexSize: ${stats.totalIndexSize} bytes` : '',
      `- Databases counted: ${counted.join(', ')}`,
      `- Cluster total before: ${mb(before)}, after: ${mb(after)}`,
      'Compare this total with Atlas Logical Size. They should be within about 10 percent.',
      `- Stopped by the size budget: ${stoppedByBudget ? `yes. ${stopReason}` : 'no'}`,
      timings
        ? `- Vault list query over ${timings.count} accounts: median ${timings.median.toFixed(1)} ms, 95th percentile ${timings.p95.toFixed(1)} ms (includes network time from this PC to Atlas)`
        : '- No timings (no records inserted)',
      timings ? `- Server executionTimeMillis (explain, median): ${timings.serverMedianMs} ms` : '',
      timings ? `- Winning plan: ${timings.plans.join(', ')} (IXSCAN is an index scan, COLLSCAN reads the whole collection)` : '',
      timings ? `- Median totalDocsExamined: ${timings.medianExamined}, median nReturned: ${timings.medianReturned}` : '',
      '',
      'Records hold no file bytes, so the app shows their size as 0. Atlas may take a minute or two to show the new size.',
      ''
    );
  } finally {
    await mongoose.disconnect();
  }
  const text = report.filter((line) => line !== undefined).join('\n');
  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, text);
  console.log(`\n${text}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.dryRun) {
    const plan = planTiers({ users: opts.users, rngSeed: opts.rngSeed });
    printPlan(plan);
    const rng = makeRng(opts.rngSeed + 7);
    const samples = [];
    for (let i = 0; i < plan.accounts.length && samples.length < 5; i += 1) {
      const { tier, count } = plan.accounts[i];
      if (count > 0) samples.push(makeRecords({ userId: `sample-account-${i + 1}`, tier, count: 1, rng, rngSeed: opts.rngSeed })[0]);
    }
    console.log('\nSample records:');
    for (const doc of samples) console.log(printable(doc));
    console.log(`\nDry run: no connection was made. Target database would be ${DB_NAME}.${COLLECTION}.`);
    return;
  }

  if (opts.dropDocs) {
    const mongoose = await connect();
    try {
      const result = await mongoose.connection.db.collection(COLLECTION).deleteMany({ 'seed.source': DOC_SOURCE });
      console.log(`Deleted ${result.deletedCount} simulated records from ${DB_NAME}.${COLLECTION}.`);
    } finally {
      await mongoose.disconnect();
    }
    return;
  }

  await run(opts);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { summarizeExplain, databasesToCount, planTiers, makeRecords, makeRng, parseArgs, tierCounts, TIERS, EXTENSIONS, MAX_FILE, MAX_ACCOUNT_BYTES, MAX_ACCOUNT_RECORDS };
