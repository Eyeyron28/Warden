// The REAL Express app (server.js, every middleware and router) running on 127.0.0.1 against a LOCAL, THROWAWAY MongoDB,
// with a captured mail sink. Nothing here reads an .env file, connects to Atlas or sends real email:
//   - `dotenv` is replaced by a no-op before the app loads (server.js calls dotenv.config());
//   - MONGO_URI is set explicitly, and only to a local address (test/helpers/realMongo.js refuses anything else);
//   - utils/email is replaced by a recorder.
// The emailed login code is switched off the way a development server may (OTP_ENABLED=false), so a test can sign in with
// a password; the code path itself is covered by otp.test.js.
const Module = require('module');
const http = require('node:http');

const { throwawayUri, mongoose } = require('./realMongo');

async function startLiveApp(name) {
  const uri = throwawayUri(name);
  if (!uri) return { ok: false, reason: 'WARDEN_TEST_MONGO must point at a local MongoDB' };

  const original = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === 'dotenv') return { config: () => ({}), parse: () => ({}) };
    return original.call(this, request, ...rest);
  };

  for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM', 'VERCEL', 'INVITE_CODE', 'CRON_SECRET']) delete process.env[key];
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGO_URI: uri,
    SIGNUP_MODE: 'open',
    OTP_ENABLED: 'false',
    PUBLIC_APP_URL: 'https://warden.test',
    EMERGENCY_DEMO_MODE: 'false',
  });

  const mails = [];
  const emailPath = require.resolve('../../utils/email');
  const realEmail = require('../../utils/email');
  require.cache[emailPath].exports = { ...realEmail, sendEmail: async (message) => { mails.push(message); return true; } };

  let app;
  try {
    app = require('../../server');
    await require('../../config/db')();
    await mongoose.connection.dropDatabase();
    // The unique indexes the app relies on exist before the first write.
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  } catch (err) {
    Module._load = original;
    return { ok: false, reason: `the app could not start against ${'a local MongoDB'}: ${String(err.message).slice(0, 80)}` };
  }
  Module._load = original;

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const RateLimit = mongoose.models.RateLimit;

  /** One HTTP request to the app. Rate-limit counters are cleared first, so a long run is never throttled. */
  async function api(method, path, { token, json, form, query, headers = {} } = {}) {
    await RateLimit.deleteMany({});
    const url = base + path + (query ? `?${new URLSearchParams(query)}` : '');
    const options = { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } };
    if (json !== undefined) {
      options.headers['content-type'] = 'application/json';
      options.body = JSON.stringify(json);
    }
    if (form) options.body = form;
    const response = await fetch(url, options);
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: response.status, text, body, headers: response.headers };
  }

  async function stop() {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }

  return { ok: true, app, api, mails, mongoose, stop };
}

module.exports = { startLiveApp };
