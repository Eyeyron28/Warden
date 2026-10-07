// In-memory stand-ins for the Mongoose models, so controller tests can run
// without a database and then look at every "collection" directly. They
// understand only the query shapes this codebase uses.
const path = require('node:path');
const mongoose = require('mongoose');

const isId = (v) => v instanceof mongoose.Types.ObjectId;
const isDate = (v) => v instanceof Date;
const oid = () => new mongoose.Types.ObjectId();

const norm = (v) => (v === undefined ? null : v);

function matchValue(actual, cond) {
  if (Array.isArray(actual)) {
    if (cond && typeof cond === 'object' && '$in' in cond) return actual.some((v) => cond.$in.map(String).includes(String(v)));
    if (cond === null || typeof cond !== 'object' || isDate(cond) || isId(cond)) return actual.some((v) => String(v) === String(cond));
  }
  if (cond && typeof cond === 'object' && !isDate(cond) && !isId(cond) && !Buffer.isBuffer(cond)) {
    if ('$in' in cond) return cond.$in.map(String).includes(String(actual));
    if ('$regex' in cond) return typeof actual === 'string' && new RegExp(cond.$regex).test(actual);
    if ('$ne' in cond) return String(norm(actual)) !== String(norm(cond.$ne));
    if ('$lt' in cond && (norm(actual) === null || !(actual < cond.$lt))) return false;
    if ('$lte' in cond && (norm(actual) === null || !(actual <= cond.$lte))) return false;
    if ('$gt' in cond && (norm(actual) === null || !(actual > cond.$gt))) return false;
    if ('$gte' in cond && (norm(actual) === null || !(actual >= cond.$gte))) return false;
    return true;
  }
  if (cond === null) return norm(actual) === null;
  if (isDate(actual) && isDate(cond)) return actual.getTime() === cond.getTime();
  return String(actual) === String(cond);
}

// { $lt: ['$downloadCount', '$maxDownloads'] }
function matchExpr(doc, expr) {
  const [op] = Object.keys(expr);
  const [a, b] = expr[op].map((x) => (typeof x === 'string' && x.startsWith('$') ? norm(doc[x.slice(1)]) : x));
  if (op === '$lt') return a < b || (a === null && b !== null);
  if (op === '$lte') return a <= b;
  throw new Error(`fakeDb: unsupported $expr ${op}`);
}

function matches(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return cond.some((alternative) => matches(doc, alternative));
    if (key === '$expr') return matchExpr(doc, cond);
    return matchValue(doc[key], cond);
  });
}

/** One fake model backed by world.tables[table]. `extras` can add or override methods. */
function fakeModel(world, table, extras = {}) {
  const rows = () => world.tables[table];
  const query = (result) => {
    const q = {
      select: () => q,
      limit: (n) => {
        const original = result;
        result = () => original().slice(0, n);
        return q;
      },
      session: () => q,
      sort: () => {
        const original = result;
        result = () => [...original()].reverse();
        return q;
      },
      then: (ok, bad) => Promise.resolve(result()).then(ok, bad),
    };
    return q;
  };
  const applyUpdate = (doc, update) => {
    for (const [key, amount] of Object.entries(update.$inc || {})) doc[key] = (doc[key] || 0) + amount;
    Object.assign(doc, update.$set || {});
  };
  const base = {
    create: async (doc) => {
      if (Array.isArray(doc)) {
        const made = doc.map((d) => ({ _id: oid(), ...d }));
        rows().push(...made);
        return made;
      }
      const created = { _id: oid(), attempts: 0, resendCount: 0, ...doc };
      rows().push(created);
      return created;
    },
    insertMany: async (docs) => {
      for (const doc of docs) rows().push({ _id: oid(), ...doc });
    },
    find: (filter = {}) => query(() => rows().filter((r) => matches(r, filter))),
    findOne: (filter) => {
      const q = query(() => rows().find((r) => matches(r, filter)) || null);
      return q;
    },
    findById: async (id) => rows().find((r) => String(r._id) === String(id)) || null,
    findOneAndUpdate: async (filter, update, options) => {
      const doc = rows().find((r) => matches(r, filter));
      if (!doc) return null;
      const before = { ...doc };
      applyUpdate(doc, update);
      return options?.new ? doc : before;
    },
    findOneAndDelete: async (filter) => {
      const index = rows().findIndex((r) => matches(r, filter));
      return index === -1 ? null : rows().splice(index, 1)[0];
    },
    updateOne: async (filter, update) => {
      const doc = rows().find((r) => matches(r, filter));
      if (doc) applyUpdate(doc, update);
      return { matchedCount: doc ? 1 : 0 };
    },
    updateMany: async (filter, update) => {
      const hits = rows().filter((r) => matches(r, filter));
      hits.forEach((doc) => applyUpdate(doc, update));
      return { matchedCount: hits.length };
    },
    deleteOne: async (filter) => {
      const index = rows().findIndex((r) => matches(r, filter));
      if (index !== -1) rows().splice(index, 1);
      return { deletedCount: index === -1 ? 0 : 1 };
    },
    deleteMany: async (filter) => {
      if (world.fail === table) {
        world.fail = null;
        throw new Error(`injected failure while deleting ${table}`);
      }
      const keep = rows().filter((r) => !matches(r, filter));
      const deletedCount = rows().length - keep.length;
      world.tables[table] = keep;
      return { deletedCount };
    },
    aggregate: () => {
      const q = { session: () => q, then: (ok, bad) => Promise.resolve([]).then(ok, bad) };
      return q;
    },
    distinct: async (field, filter = {}) => [...new Set(rows().filter((r) => matches(r, filter)).map((r) => r[field]))],
    exists: async (filter) => (rows().some((r) => matches(r, filter)) ? { _id: 1 } : null),
    countDocuments: (filter = {}) => query(() => rows().filter((r) => matches(r, filter)).length),
  };
  return { ...base, ...extras };
}

function stubModule(modulePath, exportsObject) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObject };
}

const MODEL_TABLES = {
  User: 'users', Document: 'documents', Folder: 'folders', BackupLog: 'backuplogs', PairedDevice: 'paireddevices',
  PairingToken: 'pairingtokens', RecoveryRequestToken: 'recoveryrequesttokens', Share: 'shares',
  SharedFile: 'sharedfiles', ShareAccess: 'shareaccess', Session: 'sessions', OtpChallenge: 'otpchallenges',
  RateLimit: 'ratelimits', TrashFolder: 'trashfolders', TrustedDevice: 'trusteddevices',
};

function createWorld() {
  return { tables: Object.fromEntries(Object.values(MODEL_TABLES).map((t) => [t, []])), mails: [], fail: null };
}

/** Installs a fake for every model (call BEFORE requiring any controller). */
function installModels(world, extras = {}) {
  for (const [modelName, table] of Object.entries(MODEL_TABLES)) {
    stubModule(path.join(__dirname, '..', '..', 'models', modelName), fakeModel(world, table, extras[modelName]));
  }
}

/** A budget counter standing in for middleware/rateLimit (windows are not simulated). */
function installRateLimit() {
  const counts = new Map();
  stubModule(path.join(__dirname, '..', '..', 'middleware', 'rateLimit'), {
    consumeBudget: async ({ name, key, max }) => {
      const id = `${name}:${key}`;
      counts.set(id, (counts.get(id) || 0) + 1);
      return counts.get(id) <= max;
    },
    isBudgetExhausted: async ({ name, key, max }) => (counts.get(`${name}:${key}`) || 0) >= max,
  });
  return counts;
}

function installMailer(world) {
  const real = require('../../utils/email');
  stubModule(path.join(__dirname, '..', '..', 'utils', 'email'), {
    ...real,
    sendEmail: async (message) => {
      world.mails.push(message);
      return true;
    },
  });
}

/** Runs an Express handler against a fake request and reports what it did. */
async function call(handler, { userId, dek, body = {}, params = {}, headers = {}, query = {}, secure = true } = {}) {
  const out = { status: null, json: null, headers: {}, body: null, error: null, cookies: {}, cleared: [] };
  const res = {
    setHeader(name, value) { out.headers[name.toLowerCase()] = value; },
    status(code) { out.status = code; return this; },
    json(payload) { out.json = payload; return this; },
    end(buffer) { out.body = buffer; return this; },
    send(buffer) { out.body = buffer; return this; },
    cookie(name, value, options) { out.cookies[name] = { value, ...options }; return this; },
    clearCookie(name) { out.cleared.push(name); return this; },
  };
  await handler({ userId, dek, body, params, headers, query, secure }, res, (err) => { out.error = err; });
  return out;
}

module.exports = { oid, matches, fakeModel, stubModule, createWorld, installModels, installRateLimit, installMailer, call };
