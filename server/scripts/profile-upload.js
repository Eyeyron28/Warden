const http = require('node:http');
const path = require('node:path');

const RUNS = Number(process.env.RUNS || 6);
const SIZE = 4 * 1024 * 1024 - 64 * 1024;
const stages = [];
let current = null;
const wrap = (target, key, label) => {
  const original = target[key];
  target[key] = function timed(...args) {
    const start = process.hrtime.bigint();
    const done = () => {
      if (current) current[label] = (current[label] || 0) + Number(process.hrtime.bigint() - start) / 1e6;
    };
    let result;
    try {
      result = original.apply(this, args);
    } catch (error) {
      done();
      throw error;
    }
    if (result && typeof result.then === 'function') return result.finally(done);
    done();
    return result;
  };
};

(async () => {
  const { throwawayUri, mongoose } = require('../test/helpers/realMongo');
  const uri = throwawayUri('profile_upload');
  if (!uri) throw new Error('WARDEN_TEST_MONGO must be local');
  const Module = require('module');
  const load = Module._load;
  Module._load = function stubbed(request, ...rest) {
    return request === 'dotenv' ? { config: () => ({}), parse: () => ({}) } : load.call(this, request, ...rest);
  };
  for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM', 'VERCEL', 'INVITE_CODE', 'CRON_SECRET']) delete process.env[key];
  Object.assign(process.env, { NODE_ENV: 'test', MONGO_URI: uri, SIGNUP_MODE: 'open', OTP_ENABLED: 'false', PUBLIC_APP_URL: 'https://warden.test', EMERGENCY_DEMO_MODE: 'false', STORAGE_QUOTA_MB: '200' });
  require('dns').promises.resolveMx = async () => [{ exchange: 'mx.example.test', priority: 10 }];
  const mails = [];
  const emailPath = require.resolve('../utils/email');
  const realEmail = require('../utils/email');
  require.cache[emailPath].exports = { ...realEmail, sendEmail: async (m) => { mails.push(m); return true; } };

  wrap(require('../utils/storage'), 'assertCanStore', 'quota check');
  wrap(require('../utils/folders'), 'ensureFolderPath', 'folder lookup');
  wrap(require('../utils/crypto'), 'encryptFile', 'encryption (AES-256-GCM)');
  wrap(require('../utils/thumbnails'), 'encryptThumbnail', 'thumbnail encrypt');
  wrap(require('../utils/sniff'), 'sniffImageType', 'type sniffing');
  wrap(require('../utils/sniff'), 'sniffPreviewType', 'type sniffing');
  wrap(require('../utils/sniff'), 'sniffPreviewKind', 'type sniffing');
  wrap(require('../utils/audit'), 'recordEvent', 'audit event');
  const Document = require('../models/Document');
  wrap(Document, 'create', 'database write (document)');
  const controller = require('../controllers/documents.controller');
  const createDocument = controller.createDocument;
  controller.createDocument = (req, res, next) => {
    if (current) current.entered = process.hrtime.bigint();
    return createDocument(req, res, next);
  };

  const app = require('../server');
  await require('../config/db')();
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));
  Module._load = load;

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/documents') {
      current = { began: process.hrtime.bigint() };
      res.on('finish', () => {
        current.finished = process.hrtime.bigint();
      });
    }
    app(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, route, { token, json, form } = {}) => {
    await mongoose.models.RateLimit.deleteMany({});
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    let body;
    if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) body = form;
    const response = await fetch(base + route, { method, headers, body });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const email = 'profile@example.com';
  const password = 'Qx7!vTr29#mLpw';
  await api('POST', '/api/auth/signup/start', { json: { email, password, termsAccepted: true } });
  const code = /(?<![\d-])(\d{6})(?![\d-])/.exec(mails.at(-1).text)[1];
  const token = (await api('POST', '/api/auth/signup/verify', { json: { email, password, code } })).body.sessionToken;

  const bytes = Buffer.alloc(SIZE);
  require('crypto').randomFillSync(bytes);
  Buffer.from('%PDF-1.4\n').copy(bytes);
  const thumb = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');

  for (let run = 0; run < RUNS + 1; run += 1) {
    current = null;
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), `profile-${run}.pdf`);
    form.append('thumb', new Blob([thumb], { type: 'image/webp' }), 'thumb');
    const started = process.hrtime.bigint();
    const response = await fetch(`${base}/api/documents`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
    await response.arrayBuffer();
    const ended = process.hrtime.bigint();
    if (response.status !== 201) throw new Error(`upload answered ${response.status}`);
    if (run === 0) continue;
    const ms = (a, b) => Number(b - a) / 1e6;
    const row = { ...current };
    row['request: transfer and body parse'] = ms(current.began, current.entered);
    row['response (after the last step)'] = 0;
    row.server = ms(current.began, current.finished);
    row.total = ms(started, ended);
    stages.push(row);
  }

  const mean = (key) => stages.reduce((sum, row) => sum + (row[key] || 0), 0) / stages.length;
  const order = ['request: transfer and body parse', 'type sniffing', 'quota check', 'folder lookup', 'encryption (AES-256-GCM)', 'thumbnail encrypt', 'database write (document)', 'audit event'];
  console.log(`\nPOST /api/documents, ${(SIZE / 1024 / 1024).toFixed(2)} MB PDF + preview, mean of ${stages.length} runs, local throwaway MongoDB:`);
  let accounted = 0;
  for (const key of order) {
    console.log(`  ${key.padEnd(36)} ${mean(key).toFixed(1).padStart(8)} ms`);
    accounted += mean(key);
  }
  const server_ms = mean('server');
  console.log(`  ${'other server work (checksum, response)'.padEnd(36)} ${(server_ms - accounted + mean('request: transfer and body parse')).toFixed(1).padStart(8)} ms`);
  console.log(`  ${'server total (request seen -> response sent)'.padEnd(36)} ${server_ms.toFixed(1).padStart(8)} ms`);
  console.log(`  ${'client total (fetch start -> body read)'.padEnd(36)} ${mean('total').toFixed(1).padStart(8)} ms`);
  void path;
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
