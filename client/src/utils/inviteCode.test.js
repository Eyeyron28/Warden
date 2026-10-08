import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INVITE_MAX_LENGTH,
  INVITE_REJECTED_MESSAGE,
  cleanInviteCode,
  describeSignupFailure,
  formatRetry,
  inviteFieldError,
} from './inviteCode.js';

test('the code is trimmed (a paste often carries spaces and a newline)', () => {
  assert.equal(cleanInviteCode('  abc-123 \n'), 'abc-123');
  assert.equal(cleanInviteCode(undefined), '');
  assert.equal(cleanInviteCode(null), '');
});

test('the field is invalid when empty, whitespace-only or too long', () => {
  assert.match(inviteFieldError(''), /Enter your invite code/);
  assert.match(inviteFieldError('   \n\t'), /Enter your invite code/);
  assert.match(inviteFieldError('x'.repeat(INVITE_MAX_LENGTH + 1)), /at most/);
  assert.equal(inviteFieldError('  a-real-code  '), '');
  assert.equal(inviteFieldError('x'.repeat(INVITE_MAX_LENGTH)), '');
});

test('INVITE_CODE_INVALID goes under the invite field, whatever the status text says', () => {
  const failure = describeSignupFailure({ response: { status: 403, data: { error: { code: 'INVITE_CODE_INVALID', message: 'x' } } } });
  assert.deepEqual(failure, { kind: 'invite', message: INVITE_REJECTED_MESSAGE });
});

test('a rate limit shows the retry time', () => {
  const failure = describeSignupFailure({ response: { status: 429, data: { error: { retryAfterSeconds: 725 } } } });
  assert.equal(failure.kind, 'rate');
  assert.equal(failure.retryAfterSeconds, 725);
  assert.match(failure.message, /try again in about 13 minutes/);
  assert.match(describeSignupFailure({ response: { status: 429, data: { error: {} } } }).message, /a little while/);
});

test('password-policy errors and everything else keep their own place', () => {
  assert.deepEqual(describeSignupFailure({ response: { status: 400, data: { error: { errors: ['A', 'B'] } } } }), { kind: 'password', message: 'A B' });
  assert.equal(describeSignupFailure({ response: { status: 500, data: { error: { message: 'Boom' } } } }).message, 'Boom');
  assert.match(describeSignupFailure(new Error('network')).message, /couldn’t create/);
});

test('retry times read naturally', () => {
  assert.equal(formatRetry(1), '1 second');
  assert.equal(formatRetry(45), '45 seconds');
  assert.equal(formatRetry(300), 'about 5 minutes');
  assert.equal(formatRetry(7200), 'about 2 hours');
  assert.equal(formatRetry(0), 'a little while');
});
