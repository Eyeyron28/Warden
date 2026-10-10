// Run with: cd server && npm test
//
// The same lockout sequence on the in-memory fake (test/helpers/fakeDb.js evaluates the real pipeline update), so the
// fake and MongoDB are held to the same answers; plus the shared client-address key (utils/clientIp.js).
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const db = require('./helpers/fakeDb');
const world = db.installLoginFailures();
const { reserveLoginAttempt, loginKey } = require('../utils/loginLimiter');
const { ipKey } = require('../utils/clientIp');

test('the fake evaluates the same lockout sequence as MongoDB', async () => {
  const t0 = new Date('2030-01-01T00:00:00Z');
  const at = (ms) => new Date(t0.getTime() + ms);
  const shape = (r) => [r.granted, r.locked];
  const email = 'a@example.com';
  assert.deepEqual(shape(await reserveLoginAttempt(email, { now: at(0) })), [true, false]);
  assert.deepEqual(shape(await reserveLoginAttempt(email, { now: at(1000) })), [true, false]);
  assert.deepEqual(shape(await reserveLoginAttempt(email, { now: at(5 * 60 * 1000 + 1) })), [true, false]);
  assert.equal(world.tables.loginfailures[0].count, 1);
  await reserveLoginAttempt(email, { now: at(5 * 60 * 1000 + 2000) });
  const locking = await reserveLoginAttempt(email, { now: at(5 * 60 * 1000 + 3000) });
  assert.deepEqual(shape(locking), [true, true]);
  assert.deepEqual(shape(await reserveLoginAttempt(email, { now: at(10 * 60 * 1000) })), [false, true]);
  assert.deepEqual(shape(await reserveLoginAttempt(email, { now: at(10 * 60 * 1000 + 4000) })), [true, false]);
});

test('the key is the same for the same address however it is typed, and differs between addresses', () => {
  assert.equal(loginKey(' Victim@Example.com '), loginKey('victim@example.com'));
  assert.notEqual(loginKey('a@example.com'), loginKey('b@example.com'));
  assert.match(loginKey('a@example.com'), /^[0-9a-f]{64}$/);
});

test('ipKey: IPv4 unchanged, IPv4-mapped IPv6 is the IPv4, IPv6 is its /64', () => {
  assert.equal(ipKey('203.0.113.9'), '203.0.113.9');
  assert.equal(ipKey('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(ipKey('::ffff:cb00:7109'), '203.0.113.9');
  // Different addresses of one /64 share a key; another /64 does not.
  const a = ipKey('2001:db8:abcd:12:1:2:3:4');
  assert.equal(a, '2001:0db8:abcd:0012::/64');
  assert.equal(ipKey('2001:db8:abcd:12:ffff:ffff:ffff:ffff'), a);
  assert.equal(ipKey('2001:DB8:ABCD:12::1'), a);
  assert.notEqual(ipKey('2001:db8:abcd:13::1'), a);
  assert.equal(ipKey('::1'), '0000:0000:0000:0000::/64');
  assert.equal(ipKey('fe80::1%eth0'), 'fe80:0000:0000:0000::/64');
  assert.equal(ipKey(undefined), 'unknown');
  assert.equal(ipKey(''), 'unknown');
  assert.equal(ipKey('not an ip'), 'raw:not an ip');
});
