// Run with: cd server && npm test   (Node's built-in test runner, no deps)
//
// A dead bearer token is tagged SESSION_INVALID so the client can tell it
// apart from other 401s (a wrong password or code) and only then end its session.
const test = require('node:test');
const assert = require('node:assert/strict');

const resolved = require.resolve('../utils/sessionStore');
require.cache[resolved] = {
  id: resolved,
  filename: resolved,
  loaded: true,
  exports: { getSession: async () => null, refreshSession: async () => {} },
};

const requireSession = require('../middleware/requireSession');
const { errorHandler } = require('../middleware/errorHandler');

function run(headers) {
  return new Promise((resolve) => {
    requireSession({ headers }, {}, (err) => resolve(err));
  });
}

test('missing and unknown bearer tokens are 401 SESSION_INVALID, and the code reaches the client', async () => {
  for (const headers of [{}, { authorization: 'Bearer nope.nope' }, { authorization: 'Basic abc' }]) {
    const err = await run(headers);
    assert.equal(err.status, 401);
    assert.equal(err.code, 'SESSION_INVALID');
    let body;
    errorHandler(err, {}, { statusCode: 200, status() { return this; }, json(payload) { body = payload; } }, () => {});
    assert.equal(body.error.code, 'SESSION_INVALID');
  }
});

test('other errors do not carry that code', () => {
  const err = Object.assign(new Error('Incorrect email or password.'), { status: 401 });
  let body;
  errorHandler(err, {}, { statusCode: 200, status() { return this; }, json(payload) { body = payload; } }, () => {});
  assert.equal(body.error.code, undefined);
});
