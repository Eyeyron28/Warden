import test from 'node:test';
import assert from 'node:assert/strict';

import { STEPS, backStep, describeResetFailure, formatRecoveryKeyInput, recoveryKeyProblem } from './passwordReset.js';

test('the recovery key box groups what is typed or pasted and forgives spaces, dashes and case', () => {
  assert.equal(formatRecoveryKeyInput('abcd efgh  jkmn-pqrs'), 'ABCD-EFGH-JKMN-PQRS');
  assert.equal(formatRecoveryKeyInput('ABCDEFGHJKMNPQRS'), 'ABCD-EFGH-JKMN-PQRS');
  assert.equal(formatRecoveryKeyInput('abcde'), 'ABCD-E');
  assert.equal(formatRecoveryKeyInput('  '), '');
  assert.equal(formatRecoveryKeyInput('ABCDEFGHJKMNPQRSTUVWX'), 'ABCD-EFGH-JKMN-PQRS', 'extra characters are dropped');
  assert.equal(formatRecoveryKeyInput(undefined), '');
});

test('recoveryKeyProblem says what is wrong, and is empty for a well-formed key', () => {
  assert.equal(recoveryKeyProblem('ABCD-EFGH-JKMN-PQRS'), '');
  assert.equal(recoveryKeyProblem('abcd efgh jkmn pqrs'), '');
  assert.match(recoveryKeyProblem(''), /Enter your recovery key/);
  assert.match(recoveryKeyProblem('ABCD-EFGH'), /16 characters/);
  assert.match(recoveryKeyProblem('ABCD-EFGH-JKMN-PQR0'), /never contains/);
  assert.match(recoveryKeyProblem('ABCD-EFGH-JKMN-PQRSA'), /too long/);
});

test('three steps, and Back goes one screen back (the spent code means choose goes to a fresh start)', () => {
  assert.deepEqual(Object.values(STEPS).filter((n, i, all) => all.indexOf(n) === i), [1, 2, 3]);
  assert.equal(backStep('code'), 'email');
  assert.equal(backStep('choose'), 'email');
  assert.equal(backStep('keep'), 'choose');
  assert.equal(backStep('wipeWarn'), 'choose');
  assert.equal(backStep('wipeForm'), 'wipeWarn');
  assert.equal(backStep('keyOnly'), 'email');
  assert.equal(backStep('email'), null);
  assert.equal(backStep('newKey'), null, 'the new recovery key is shown once: no way back');
});

test('failures are sorted into what the page should do', () => {
  const err = (status, error) => ({ response: { status, data: { error } } });
  assert.equal(describeResetFailure(err(401, { code: 'RESET_TICKET_INVALID', message: 'x' })).kind, 'ticket');
  const rate = describeResetFailure(err(429, { retryAfterSeconds: 600 }));
  assert.equal(rate.kind, 'rate');
  assert.match(rate.message, /about 10 minutes/);
  assert.equal(describeResetFailure(err(401, { message: 'The email or recovery key is incorrect.' })).message, 'The email or recovery key is incorrect.');
  assert.equal(describeResetFailure(err(400, { errors: ['A', 'B'] })).kind, 'policy');
  assert.equal(describeResetFailure(err(400, { message: 'The email you typed does not match this account.' })).kind, 'mismatch');
  assert.equal(describeResetFailure(new Error('network')).kind, 'other');
});
