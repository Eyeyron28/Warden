// Run with: cd server && npm test   (Node's built-in test runner, no deps)
//
// PUBLIC_APP_URL: the only source of the origin used in share links and
// emails. Never taken from request headers.
const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePublicAppUrl, assertPublicAppUrlConfig, getPublicAppUrl } = require('../utils/publicAppUrl');

function withEnv(values, fn) {
  const saved = {};
  for (const name of ['PUBLIC_APP_URL', 'NODE_ENV', 'VERCEL', 'LAN_IP']) saved[name] = process.env[name];
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('accepts a plain https origin (a trailing slash is fine)', () => {
  assert.equal(parsePublicAppUrl('https://warden.example.com'), 'https://warden.example.com');
  assert.equal(parsePublicAppUrl('https://warden.example.com/'), 'https://warden.example.com');
  assert.equal(parsePublicAppUrl('https://warden.example.com:8443'), 'https://warden.example.com:8443');
});

test('rejects anything that is not just an https origin', () => {
  for (const bad of [
    'http://warden.example.com',
    'warden.example.com',
    '//warden.example.com',
    'https://user@warden.example.com',
    'https://user:pw@warden.example.com',
    'https://warden.example.com/app',
    'https://warden.example.com?x=1',
    'https://warden.example.com/#frag',
    'javascript:alert(1)',
    '',
  ]) {
    assert.throws(() => parsePublicAppUrl(bad), Error, bad);
  }
});

test('production requires it; development falls back to the LAN address', () => {
  withEnv({ PUBLIC_APP_URL: undefined, NODE_ENV: 'production', VERCEL: undefined }, () => {
    assert.throws(() => assertPublicAppUrlConfig(), /required in production/);
    assert.equal(getPublicAppUrl(), null);
  });
  withEnv({ PUBLIC_APP_URL: undefined, NODE_ENV: 'development', VERCEL: '1' }, () => {
    assert.throws(() => assertPublicAppUrlConfig(), /required in production/, 'Vercel counts as production');
  });
  withEnv({ PUBLIC_APP_URL: undefined, NODE_ENV: 'development', VERCEL: undefined, LAN_IP: '192.168.1.50' }, () => {
    assert.deepEqual(assertPublicAppUrlConfig(), { source: 'lan', origin: 'https://192.168.1.50:5173' });
  });
  withEnv({ PUBLIC_APP_URL: 'https://warden.example.com', NODE_ENV: 'production' }, () => {
    assert.deepEqual(assertPublicAppUrlConfig(), { source: 'env', origin: 'https://warden.example.com' });
  });
  withEnv({ PUBLIC_APP_URL: 'http://insecure.example.com', NODE_ENV: 'development' }, () => {
    assert.throws(() => assertPublicAppUrlConfig(), /https/, 'a bad value fails even in development');
  });
});
