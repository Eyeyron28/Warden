const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { productionConfigProblems } = require('../utils/productionConfig');

const GOOD = {
  NODE_ENV: 'production',
  MONGO_URI: 'mongodb+srv://u:p@cluster.example.net/warden',
  PUBLIC_APP_URL: 'https://warden.example.com',
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '465',
  SMTP_USER: 'user',
  SMTP_PASS: 'secret-pass',
  MAIL_FROM: 'Warden <no-reply@example.com>',
  SIGNUP_MODE: 'invite',
  INVITE_CODE: 'a-long-random-invite-code',
};
const KEYS = [...Object.keys(GOOD), 'OTP_ENABLED', 'STORAGE_QUOTA_MB', 'VERCEL'];

function withEnv(env, fn) {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const names = (env) => withEnv(env, () => productionConfigProblems().map((problem) => problem.name));

test('a complete production configuration passes', () => {
  assert.deepEqual(names(GOOD), []);
  assert.deepEqual(names({ ...GOOD, SIGNUP_MODE: 'open', INVITE_CODE: '', STORAGE_QUOTA_MB: '50' }), []);
});

test('each required setting is reported by name when missing or invalid', () => {
  for (const key of ['MONGO_URI', 'PUBLIC_APP_URL', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM', 'SIGNUP_MODE', 'INVITE_CODE']) {
    const env = { ...GOOD };
    delete env[key];
    assert.ok(names(env).includes(key), `${key} missing`);
  }
  assert.ok(names({ ...GOOD, PUBLIC_APP_URL: 'http://warden.example.com' }).includes('PUBLIC_APP_URL'));
  assert.ok(names({ ...GOOD, PUBLIC_APP_URL: 'https://warden.example.com/app' }).includes('PUBLIC_APP_URL'));
  assert.ok(names({ ...GOOD, OTP_ENABLED: 'false' }).includes('OTP_ENABLED'));
  assert.ok(names({ ...GOOD, SIGNUP_MODE: 'closed' }).includes('SIGNUP_MODE'));
  assert.ok(names({ ...GOOD, INVITE_CODE: 'short' }).includes('INVITE_CODE'));
  assert.ok(names({ ...GOOD, MONGO_URI: 'postgres://x' }).includes('MONGO_URI'));
  for (const bad of ['0', '-5', 'abc']) assert.ok(names({ ...GOOD, STORAGE_QUOTA_MB: bad }).includes('STORAGE_QUOTA_MB'), bad);
});

test('messages name variables and never contain their values', () => {
  const messages = withEnv({ ...GOOD, INVITE_CODE: 'tooshort', SMTP_PASS: '' }, () => JSON.stringify(productionConfigProblems()));
  assert.ok(!messages.includes('tooshort'));
  assert.ok(!messages.includes('u:p@'));
});

test('running on Vercel counts as production', () => {
  const { assertProductionConfig } = require('../utils/productionConfig');
  withEnv({ VERCEL: '1' }, () => assert.throws(() => assertProductionConfig(), /MONGO_URI/));
  withEnv({ NODE_ENV: 'development' }, () => assert.doesNotThrow(() => assertProductionConfig()));
});

test('vercel.json: cache rules, headers and the CSP script hash match the real page', () => {
  const root = path.join(__dirname, '..', '..');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const rule = (source) => config.headers.find((entry) => entry.source === source);
  const header = (entry, key) => entry.headers.find((item) => item.key === key)?.value;

  assert.match(header(rule('/assets/(.*)'), 'Cache-Control'), /immutable/);
  assert.equal(header(rule('/api/(.*)'), 'Cache-Control'), 'no-store');
  const pages = config.headers.find((entry) => entry.source.includes('?!'));
  assert.equal(header(pages, 'Cache-Control'), 'no-cache');
  assert.equal(header(pages, 'X-Content-Type-Options'), 'nosniff');
  assert.match(header(pages, 'Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal(header(rule('/shared/(.*)'), 'Referrer-Policy'), 'no-referrer');

  // The inline theme script in index.html is allowed by hash; editing it without updating the hash would blank every page.
  const html = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');
  const inline = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const hash = `'sha256-${crypto.createHash('sha256').update(inline).digest('base64')}'`;
  assert.ok(header(pages, 'Content-Security-Policy').includes(hash), 'app CSP hash');
  assert.ok(header(rule('/shared/(.*)'), 'Content-Security-Policy').includes(hash), 'share CSP hash');

  assert.ok(config.functions['api/index.js'].maxDuration <= 300);
  assert.ok(config.crons.every((cron) => /^\S+ \S+ \* \* \S+$/.test(cron.schedule)), 'Hobby cron: once a day');
});

test('CORS: the deployed app origin (PUBLIC_APP_URL) may call its own API; others may not', () => {
  const saved = { c: process.env.CORS_ORIGINS, p: process.env.PUBLIC_APP_URL };
  delete process.env.CORS_ORIGINS;
  process.env.PUBLIC_APP_URL = 'https://warden.example.com';
  delete require.cache[require.resolve('../config/cors')];
  const { origin } = require('../config/cors');
  const check = (value) => new Promise((resolve) => origin(value, (err, ok) => resolve(!err && ok)));
  return Promise.all([check('https://warden.example.com'), check('https://evil.example.com'), check(undefined)]).then(([own, other, none]) => {
    assert.equal(own, true);
    assert.equal(other, false);
    assert.equal(none, true);
    if (saved.c === undefined) delete process.env.CORS_ORIGINS; else process.env.CORS_ORIGINS = saved.c;
    if (saved.p === undefined) delete process.env.PUBLIC_APP_URL; else process.env.PUBLIC_APP_URL = saved.p;
    delete require.cache[require.resolve('../config/cors')];
  });
});

test('cron route: absent without CRON_SECRET, 401 without the right bearer token', async () => {
  const express = require('express');
  const http = require('node:http');
  const cron = require('../routes/cron.routes');
  const app = express();
  app.use('/api/cron', cron);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const get = (headers = {}) =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/cron/purge-trash', headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }).on('error', reject);
    });
  const saved = process.env.CRON_SECRET;
  try {
    delete process.env.CRON_SECRET;
    assert.equal(await get({ authorization: 'Bearer anything' }), 404, 'no secret configured: endpoint does not exist');
    process.env.CRON_SECRET = 'a-long-random-cron-secret';
    assert.equal(await get(), 401);
    assert.equal(await get({ authorization: 'Bearer wrong' }), 401);
    assert.equal(await get({ authorization: 'a-long-random-cron-secret' }), 401, 'the Bearer prefix is required');
  } finally {
    if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved;
    server.close();
  }
});

test('drive backup is switched off in production (no server paths on a hosted server)', async () => {
  const { exportBackup, importBackup } = require('../controllers/backup.controller');
  const saved = { v: process.env.VERCEL, n: process.env.NODE_ENV };
  process.env.VERCEL = '1';
  try {
    for (const handler of [exportBackup, importBackup]) {
      const status = await new Promise((resolve) => handler({ body: { targetPath: '/tmp/x', sourcePath: '/tmp/x' }, userId: 'u' }, {}, (err) => resolve(err && err.status)));
      assert.equal(status, 501);
    }
  } finally {
    if (saved.v === undefined) delete process.env.VERCEL; else process.env.VERCEL = saved.v;
  }
});
