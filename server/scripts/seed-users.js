#!/usr/bin/env node
/* eslint-disable no-console */
// Loads synthetic shell accounts into a SEPARATE database ("warden_seed") for a size and load test.
// The accounts can never be logged into: every secret field is random bytes in the right shape.
//
//   WARDEN_SEED_URI="mongodb+srv://..." node scripts/seed-users.js --limit 1000
//   node scripts/seed-users.js --dry-run --limit 5      (no connection at all)
//   node scripts/seed-users.js --drop-seed              (removes only the seeded documents)
//   node scripts/seed-users.js --drop-db                (drops the whole warden_seed database, asks first)
//
// Documents go in through the raw collection, so the User model and app code are not touched.

const crypto = require('crypto');
const { mkdirSync, readFileSync, writeFileSync } = require('fs');
const path = require('path');
const readline = require('readline');

const DB_NAME = 'warden_seed';
const COLLECTION = 'users';
const SEED_SOURCE = 'kaggle-socialmedia-users';
const CSV_PATH = path.join(__dirname, 'data', 'SocialMediaUsersDataset.csv');
const REPORT_PATH = path.join(__dirname, 'out', 'seed-report.md');
const TARGET_ACCOUNTS = 40000;

// Small CSV reader: quoted fields may hold commas, doubled quotes and line breaks.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((cell) => cell !== '')) rows.push(row);
  return rows;
}

// Turns CSV text into objects keyed by the header names.
function readUsers(text) {
  const [header, ...rest] = parseCsv(text);
  if (!header) return [];
  const names = header.map((name) => name.trim());
  return rest.map((cells) => Object.fromEntries(names.map((name, i) => [name, (cells[i] ?? '').trim()])));
}

const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');
const b64 = (bytes) => crypto.randomBytes(bytes).toString('base64');

// One CSV row to one User document. Only the user id is used: the User model has no display
// name field, and gender, birth date, interests and place are never stored.
function mapRow(csvRow, rowNumber, now = new Date()) {
  const userId = String(csvRow.UserID ?? '').trim();
  return {
    email: `u${userId}@seed.invalid`,
    emailVerified: false,
    // Random bytes, same shapes as utils/crypto.js: no password or recovery key can ever match.
    passwordHash: hex(64),
    salt: hex(16),
    recoveryKeyHash: `${hex(16)}:${hex(64)}`,
    wrappedDEKPassword: b64(32),
    wrappedDEKPasswordIv: b64(12),
    wrappedDEKPasswordAuthTag: b64(16),
    wrappedDEKRecovery: b64(32),
    wrappedDEKRecoveryIv: b64(12),
    wrappedDEKRecoveryAuthTag: b64(16),
    dekFingerprint: hex(32),
    failedAttempts: 0,
    expiryReminders: false,
    auditHead: { seq: 0, hash: '', at: null },
    createdAt: now,
    seed: { source: SEED_SOURCE, row: rowNumber },
  };
}

function parseArgs(argv) {
  const opts = { limit: 1000, batch: 500, pauseMs: 1500, dryRun: false, dropSeed: false, dropDb: false };
  const number = (flag, value) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} needs a whole number`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--limit') opts.limit = number(flag, argv[++i]);
    else if (flag === '--batch') opts.batch = Math.max(1, number(flag, argv[++i]));
    else if (flag === '--pause-ms') opts.pauseMs = number(flag, argv[++i]);
    else if (flag === '--dry-run') opts.dryRun = true;
    else if (flag === '--drop-seed') opts.dropSeed = true;
    else if (flag === '--drop-db') opts.dropDb = true;
    else throw new Error(`Unknown option ${flag}`);
  }
  return opts;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function connect() {
  const uri = process.env.WARDEN_SEED_URI;
  if (!uri) throw new Error('WARDEN_SEED_URI is not set. Refusing to run.');
  const mongoose = require('mongoose');
  await mongoose.connect(uri, { dbName: DB_NAME });
  const name = mongoose.connection.db.databaseName;
  if (name !== DB_NAME) {
    await mongoose.disconnect();
    throw new Error(`Database resolved to "${name}", not "${DB_NAME}". Refusing to run.`);
  }
  return mongoose;
}

async function collectionStats(db) {
  try {
    const stats = await db.command({ collStats: COLLECTION });
    return { dataSize: stats.size, indexSize: stats.totalIndexSize, count: stats.count };
  } catch {
    return null;
  }
}

function buildReport({ inserted, seconds, stats }) {
  const lines = ['# Seed report', '', `- Documents inserted: ${inserted}`, `- Seconds taken: ${seconds.toFixed(1)}`];
  if (stats && stats.count > 0) {
    const average = stats.dataSize / stats.count;
    const projected = (stats.dataSize + stats.indexSize) * (TARGET_ACCOUNTS / stats.count);
    lines.push(
      `- Collection dataSize: ${stats.dataSize} bytes`,
      `- Collection indexSize: ${stats.indexSize} bytes`,
      `- Average bytes per document: ${average.toFixed(0)}`,
      `- Projected size at ${TARGET_ACCOUNTS} accounts (data + indexes): ${(projected / 1024 / 1024).toFixed(1)} MB`
    );
  } else {
    lines.push('- Collection stats were not available.');
  }
  lines.push('', 'Atlas may take a minute or two to show the new size.', '');
  return lines.join('\n');
}

function loadDocs(limit) {
  const rows = readUsers(readFileSync(CSV_PATH, 'utf8')).slice(0, limit);
  return rows.map((row, i) => mapRow(row, i + 1));
}

async function seed(opts) {
  const docs = loadDocs(opts.limit);
  const mongoose = await connect();
  const collection = mongoose.connection.db.collection(COLLECTION);
  try {
    await collection.createIndex({ email: 1 }, { unique: true });
    const started = Date.now();
    let inserted = 0;
    for (let i = 0; i < docs.length; i += opts.batch) {
      const batch = docs.slice(i, i + opts.batch);
      try {
        const result = await collection.insertMany(batch, { ordered: false });
        inserted += result.insertedCount;
      } catch (error) {
        // Duplicates from an earlier run are skipped; anything else stops the script.
        const errors = error.writeErrors || [];
        if (errors.length === 0 || !errors.every((e) => e.code === 11000)) throw error;
        inserted += batch.length - errors.length;
      }
      console.log(`Batch ${Math.floor(i / opts.batch) + 1}: ${Math.min(i + opts.batch, docs.length)} of ${docs.length} processed`);
      if (i + opts.batch < docs.length) await sleep(opts.pauseMs);
    }
    const seconds = (Date.now() - started) / 1000;
    const report = buildReport({ inserted, seconds, stats: await collectionStats(mongoose.connection.db) });
    mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, report);
    console.log(`\n${report}`);
  } finally {
    await mongoose.disconnect();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.dryRun) {
    const docs = loadDocs(opts.limit);
    console.log(JSON.stringify(docs.slice(0, 5), null, 2));
    console.log(`\nDry run: ${docs.length} documents would be inserted into ${DB_NAME}.${COLLECTION}. No connection was made.`);
    return;
  }

  if (opts.dropSeed) {
    const mongoose = await connect();
    try {
      const result = await mongoose.connection.db.collection(COLLECTION).deleteMany({ 'seed.source': SEED_SOURCE });
      console.log(`Deleted ${result.deletedCount} seeded documents from ${DB_NAME}.${COLLECTION}.`);
    } finally {
      await mongoose.disconnect();
    }
    return;
  }

  if (opts.dropDb) {
    const mongoose = await connect();
    try {
      console.log(`This will drop the whole database: ${mongoose.connection.db.databaseName}`);
      if ((await ask('Type DROP to confirm: ')).trim() !== 'DROP') {
        console.log('Cancelled.');
        return;
      }
      await mongoose.connection.db.dropDatabase();
      console.log(`Dropped ${DB_NAME}.`);
    } finally {
      await mongoose.disconnect();
    }
    return;
  }

  await seed(opts);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { parseCsv, readUsers, mapRow, parseArgs, DB_NAME };
