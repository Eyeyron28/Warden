// Run with: cd server && npm test
//
// F9: every limiter counts an IPv6 client by its /64 (one helper, utils/clientIp.js), so rotating the low bits of an
//     address does not buy a fresh budget; IPv4 is unchanged.
// F11: a limiter whose own key is empty falls back to the client address instead of skipping the limit.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const db = require('./helpers/fakeDb');
const world = db.createWorld();
db.stubModule(require('node:path').join(__dirname, '..', 'models', 'RateLimit'), db.fakeModel(world, 'ratelimits'));
const createRateLimiter = require('../middleware/rateLimit');

const hit = async (limiter, req) => {
  let error = null;
  await limiter({ body: {}, ...req }, {}, (err) => { error = err || null; });
  return error?.status ?? 200;
};
const run = async (limiter, requests) => {
  const out = [];
  for (const req of requests) out.push(await hit(limiter, req));
  return out;
};
const fresh = () => { world.tables.ratelimits.length = 0; };

test('F9: addresses of one IPv6 /64 share a budget; another /64 and IPv4 are separate', async () => {
  fresh();
  const limiter = createRateLimiter({ name: 'v6', max: 3, windowMs: 60000 });
  const sameNetwork = ['2001:db8:aaaa:1::1', '2001:db8:aaaa:1:ffff::2', '2001:DB8:AAAA:1:1:2:3:4', '2001:db8:aaaa:1::99'].map((ip) => ({ ip }));
  assert.deepEqual(await run(limiter, sameNetwork), [200, 200, 200, 429], 'the 4th address of the same /64 is over the limit');
  assert.equal(await hit(limiter, { ip: '2001:db8:aaaa:2::1' }), 200, 'a different /64 has its own budget');
  assert.equal(await hit(limiter, { ip: '203.0.113.7' }), 200, 'IPv4 has its own budget');
});

test('F9: IPv4 is unchanged (the key is the address) and an IPv4-mapped IPv6 address is that IPv4 address', async () => {
  fresh();
  const limiter = createRateLimiter({ name: 'v4', max: 2, windowMs: 60000 });
  assert.deepEqual(await run(limiter, [{ ip: '203.0.113.9' }, { ip: '::ffff:203.0.113.9' }, { ip: '203.0.113.9' }]), [200, 200, 429]);
  assert.ok(world.tables.ratelimits.some((row) => row.key === '203.0.113.9'), 'plain IPv4 key, as before');
  assert.equal(await hit(limiter, { ip: '203.0.113.10' }), 200);
});

test('F11: a limiter whose key function returns nothing still limits, by address', async () => {
  fresh();
  const limiter = createRateLimiter({ name: 'by-email', max: 3, windowMs: 60000, keyFn: (req) => req.body?.email || null });
  // no email in the body: before the fix every one of these was waved through
  const noEmail = await run(limiter, Array.from({ length: 5 }, () => ({ ip: '198.51.100.20', body: {} })));
  assert.deepEqual(noEmail, [200, 200, 200, 429, 429]);
  // another address is not affected, and a request that does carry an email is counted under the email as before
  assert.equal(await hit(limiter, { ip: '198.51.100.21', body: {} }), 200);
  assert.deepEqual(await run(limiter, Array.from({ length: 4 }, (_, i) => ({ ip: `198.51.100.${30 + i}`, body: { email: 'a@example.com' } }))), [200, 200, 200, 429]);
});

test('F11: the fallback is per /64 as well, and an empty string counts as empty', async () => {
  fresh();
  const limiter = createRateLimiter({ name: 'by-empty', max: 2, windowMs: 60000, keyFn: () => '' });
  assert.deepEqual(await run(limiter, [{ ip: '2001:db8:1:1::1' }, { ip: '2001:db8:1:1::2' }, { ip: '2001:db8:1:1::3' }]), [200, 200, 429]);
});

test('F9: the shared helper is used by the other places that count by address', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  for (const file of ['middleware/rateLimit.js', 'controllers/passwordReset.controller.js', 'utils/inviteGate.js', 'utils/emergency/service.js']) {
    assert.match(read(file), /ipKey/, `${file} goes through ipKey`);
    assert.doesNotMatch(read(file), /req\??\.ip\s*\|\|\s*'unknown'/, `${file} no longer keys by the raw address`);
  }
});
