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

const pathGet = (doc, key) => (key.includes('.') ? key.split('.').reduce((value, part) => (value == null ? undefined : value[part]), doc) : doc[key]);

function matches(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return cond.some((alternative) => matches(doc, alternative));
    if (key === '$expr') return matchExpr(doc, cond);
    const actual = pathGet(doc, key);
    if (cond && typeof cond === 'object' && !isDate(cond) && !isId(cond) && !Buffer.isBuffer(cond)) {
      if ('$exists' in cond) return (actual !== undefined) === Boolean(cond.$exists);
      if ('$nin' in cond) return !cond.$nin.map(String).includes(String(actual));
    }
    return matchValue(actual, cond);
  });
}


// A small evaluator for the aggregation-pipeline UPDATES the code uses ($set / $unset stages over $ifNull, $cond, $add,
// $gt/$gte/$lt/$lte, $or, $and, $not, $max and field references). Lets tests run the real pipeline from
// utils/loginLimiter.js against the in-memory table. Anything else throws, so a new operator is noticed.
const rank = (v) => (v === undefined || v === null ? -Infinity : isDate(v) ? v.getTime() : v);
function evalExpr(doc, expr) {
  if (typeof expr === 'string') return expr.startsWith('$') ? doc[expr.slice(1)] : expr;
  if (Array.isArray(expr)) return expr.map((e) => evalExpr(doc, e));
  if (expr === null || typeof expr !== 'object' || isDate(expr) || isId(expr)) return expr;
  const [op] = Object.keys(expr);
  const args = expr[op];
  const list = () => (Array.isArray(args) ? args : [args]).map((a) => evalExpr(doc, a));
  switch (op) {
    case '$ifNull': { const [a, b] = list(); return a === undefined || a === null ? b : a; }
    case '$cond': { const [c, t, e] = list(); return c ? t : e; }
    case '$add': {
      const values = list();
      const total = values.reduce((sum, v) => sum + (isDate(v) ? v.getTime() : v), 0);
      return values.some(isDate) ? new Date(total) : total;
    }
    case '$gt': { const [a, b] = list(); return rank(a) > rank(b); }
    case '$gte': { const [a, b] = list(); return rank(a) >= rank(b); }
    case '$lt': { const [a, b] = list(); return rank(a) < rank(b); }
    case '$lte': { const [a, b] = list(); return rank(a) <= rank(b); }
    case '$or': return list().some(Boolean);
    case '$and': return list().every(Boolean);
    case '$not': return !list()[0];
    case '$min': return list().filter((v) => v !== null && v !== undefined).reduce((m, v) => (m === undefined || rank(v) < rank(m) ? v : m), undefined);
    case '$max': return list().filter((v) => v !== null && v !== undefined).reduce((m, v) => (m === undefined || rank(v) > rank(m) ? v : m), undefined);
    default: throw new Error(`fakeDb: unsupported expression ${op}`);
  }
}
function runPipelineUpdate(doc, stages) {
  for (const stage of stages) {
    if (stage.$set) {
      const computed = Object.fromEntries(Object.entries(stage.$set).map(([key, expr]) => [key, evalExpr(doc, expr)]));
      Object.assign(doc, computed);
    } else if (stage.$unset) {
      for (const key of [].concat(stage.$unset)) delete doc[key];
    } else throw new Error('fakeDb: unsupported pipeline stage');
  }
}

// Unique indexes the code under test relies on (a create that repeats one fails like MongoDB's E11000).
const UNIQUE = { auditevents: ['userId', 'seq'], devices: ['userId', 'deviceIdHash'], reminderlogs: ['userId', 'fileId', 'threshold'] };

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
      sort: (spec) => {
        const original = result;
        if (spec && typeof spec === 'object' && 'seq' in spec) {
          result = () => [...original()].sort((a, b) => (a.seq - b.seq) * (spec.seq < 0 ? -1 : 1));
        } else {
          result = () => [...original()].reverse();
        }
        return q;
      },
      then: (ok, bad) => Promise.resolve(result()).then(ok, bad),
    };
    return q;
  };
  const applyUpdate = (doc, update) => {
    for (const [key, amount] of Object.entries(update.$inc || {})) doc[key] = (doc[key] || 0) + amount;
    Object.assign(doc, update.$set || {});
    for (const key of Object.keys(update.$unset || {})) delete doc[key];
  };
  const base = {
    create: async (doc) => {
      const unique = UNIQUE[table];
      const clash = (candidate) =>
        unique && rows().some((row) => unique.every((key) => String(row[key]) === String(candidate[key])));
      if (!Array.isArray(doc) && clash(doc)) throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
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
    findById: (id) => query(() => rows().find((r) => String(r._id) === String(id)) || null),
    findOneAndUpdate: async (filter, update, options) => {
      let doc = rows().find((r) => matches(r, filter));
      if (!doc && Array.isArray(update) && options?.upsert) {
        const seed = Object.fromEntries(Object.entries(filter).filter(([, v]) => v === null || typeof v !== 'object' || isDate(v) || isId(v)));
        doc = { _id: oid(), ...seed };
        rows().push(doc);
      }
      if (!doc) return null;
      const before = { ...doc };
      if (Array.isArray(update)) runPipelineUpdate(doc, update);
      else applyUpdate(doc, update);
      return options?.new ? doc : before;
    },
    findOneAndDelete: async (filter) => {
      const index = rows().findIndex((r) => matches(r, filter));
      return index === -1 ? null : rows().splice(index, 1)[0];
    },
    updateOne: async (filter, update) => {
      const doc = rows().find((r) => matches(r, filter));
      if (doc && Array.isArray(update)) runPipelineUpdate(doc, update);
      else if (doc) applyUpdate(doc, update);
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
    // $match / $sort ({ _id: 1 }) / $limit / $project (1, or { $binarySize }) only; any other stage gives [].
    aggregate: (pipeline = []) => {
      const run = () => {
        let out = rows();
        for (const stage of pipeline) {
          if (stage.$match) out = out.filter((r) => matches(r, stage.$match));
          else if (stage.$sort) {
            const [[field, dir]] = Object.entries(stage.$sort);
            out = [...out].sort((a, b) => (String(a[field]) < String(b[field]) ? -dir : String(a[field]) > String(b[field]) ? dir : 0));
          } else if (stage.$limit) out = out.slice(0, stage.$limit);
          else if (stage.$project) {
            out = out.map((r) => {
              const shaped = { _id: r._id };
              for (const [field, spec] of Object.entries(stage.$project)) {
                if (spec === 1) shaped[field] = r[field];
                else if (spec.$binarySize) shaped[field] = (r[spec.$binarySize.$ifNull?.[0].slice(1) || spec.$binarySize.slice(1)] || Buffer.alloc(0)).length;
              }
              return shaped;
            });
          } else return [];
        }
        return out;
      };
      const q = { session: () => q, then: (ok, bad) => Promise.resolve(run()).then(ok, bad) };
      return q;
    },
    distinct: async (field, filter = {}) => [...new Set(rows().filter((r) => matches(r, filter)).map((r) => r[field]))],
    syncIndexes: async () => [],
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
  User: 'users', Document: 'documents', Folder: 'folders', BackupLog: 'backuplogs', Device: 'devices', AuditEvent: 'auditevents', Share: 'shares',
  SharedFile: 'sharedfiles', ShareAccess: 'shareaccess', Session: 'sessions', OtpChallenge: 'otpchallenges',
  RateLimit: 'ratelimits', TrashFolder: 'trashfolders', TrustedDevice: 'trusteddevices', ResetTicket: 'resettickets', ReminderLog: 'reminderlogs', EmergencyAccess: 'emergencyaccesses', EmergencyRequest: 'emergencyrequests', LoginFailure: 'loginfailures',
};

function createWorld() {
  return { tables: Object.fromEntries(Object.values(MODEL_TABLES).map((t) => [t, []])), mails: [], fail: null };
}

/** For tests that stub models by hand: just the login-lockout counter (utils/loginLimiter.js), as its own tiny world. */
function installLoginFailures() {
  const world = { tables: { loginfailures: [] } };
  stubModule(path.join(__dirname, '..', '..', 'models', 'LoginFailure'), fakeModel(world, 'loginfailures'));
  return world;
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
  // Callable like the real module (route files build limiters with it); the per-route limiters are pass-throughs here,
  // the budgets below are what the tests exercise.
  const factory = () => (req, res, next) => next();
  stubModule(path.join(__dirname, '..', '..', 'middleware', 'rateLimit'), Object.assign(factory, {
    consumeBudget: async ({ name, key, max }) => {
      const id = `${name}:${key}`;
      counts.set(id, (counts.get(id) || 0) + 1);
      return counts.get(id) <= max;
    },
    isBudgetExhausted: async ({ name, key, max }) => (counts.get(`${name}:${key}`) || 0) >= max,
    budgetRetryAfterSeconds: async ({ name, key, max }) => ((counts.get(`${name}:${key}`) || 0) >= max ? 900 : 0),
  }));
  return counts;
}

function installMailer(world) {
  const real = require('../../utils/email');
  stubModule(path.join(__dirname, '..', '..', 'utils', 'email'), {
    ...real,
    sendEmail: async (message) => {
      if (world.throwMail) throw new Error('SMTP exploded');
      if (world.failMail) return false;
      if (world.sendDelayMs) await new Promise((resolve) => setTimeout(resolve, world.sendDelayMs));
      world.mails.push(message);
      return true;
    },
  });
}

/** Runs an Express handler against a fake request and reports what it did. */
async function call(handler, { userId, dek, body = {}, params = {}, headers = {}, query = {}, secure = true, files, file, ip = '203.0.113.9', ...extra } = {}) {
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
  await handler({ userId, dek, body, params, headers, query, secure, files, file, ip, ...extra }, res, (err) => { out.error = err; if (err && err.status) out.status = err.status; });
  return out;
}

module.exports = { oid, matches, fakeModel, stubModule, createWorld, installModels, installLoginFailures, installRateLimit, installMailer, call };
