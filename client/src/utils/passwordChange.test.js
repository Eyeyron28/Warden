import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { changePasswordErrors, startFailureMessage } from './passwordChange.js';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');

const STRONG = 'Zk4$wNb83&hRtq';

test('the form needs the current password, a strong new one, and a matching confirmation', () => {
  assert.deepEqual(changePasswordErrors({ current: 'Qx7!vTr29#mLpw', next: STRONG, confirm: STRONG }), {});
  assert.ok(changePasswordErrors({ current: '', next: STRONG, confirm: STRONG }).current);
  assert.ok(changePasswordErrors({ current: 'Qx7!vTr29#mLpw', next: 'short', confirm: 'short' }).next);
  assert.ok(changePasswordErrors({ current: 'Qx7!vTr29#mLpw', next: STRONG, confirm: `${STRONG}x` }).confirm);
  assert.ok(changePasswordErrors({ current: 'Qx7!vTr29#mLpw', next: STRONG, confirm: '' }).confirm);
});

test('the new password may not be the current one', () => {
  const errors = changePasswordErrors({ current: STRONG, next: STRONG, confirm: STRONG });
  assert.match(errors.next, /different from your current password/);
});

test('a wrong password, a weak password and a lockout each get their own plain message', () => {
  assert.equal(startFailureMessage({ response: { status: 401, data: {} } }), 'That is not your current password.');
  assert.match(startFailureMessage({ response: { status: 400, data: { error: { errors: ['x'], message: 'Password does not meet the security requirements.' } } } }), /does not meet the requirements/);
  assert.equal(startFailureMessage({ response: { status: 429, data: { error: { message: 'Too many attempts. Try again later.' } } } }), 'Too many attempts. Try again later.');
  assert.match(startFailureMessage({}), /Please try again/);
});

test('the code step reuses the code panel, sends the new password with the code, and the section ships with the Account page chunk', () => {
  const component = read('components/ChangePassword.jsx');
  assert.match(component, /<OtpChallengePanel/);
  assert.match(component, /confirmPasswordChange\(\{ challengeToken: token, code, newPassword: next \}\)/);
  assert.match(component, /autoComplete="current-password"/);
  assert.match(component, /<PasswordStrengthMeter password=\{next\} \/>/);
  assert.match(component, /autoComplete="new-password"/);
  assert.match(read('pages/AccountPage.jsx'), /import ChangePassword from '\.\.\/components\/ChangePassword\.jsx'/);
  assert.doesNotMatch(read('App.jsx'), /ChangePassword/);
  assert.match(read('services/passwordChangeService.js'), /'\/account\/password\/start'[\s\S]*'\/account\/password\/resend'[\s\S]*'\/account\/password\/confirm'/);
});
