import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) =>
  fs.readFileSync(path.join(here, '..', relative), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// [id, autoComplete] for every <Tag ... id="..." ...> in a source file.
const attrs = (source, tag) => {
  const found = [];
  // Each element runs from "<Tag" to its self-closing "/>".
  for (const chunk of source.split('<' + tag).slice(1)) {
    const element = chunk.slice(0, chunk.indexOf('/>'));
    const id = /id="([^"]+)"/.exec(element)?.[1];
    if (id) found.push([id, /autoComplete="([^"]+)"/.exec(element)?.[1] ?? '(default)']);
  }
  return found;
};

test('new-password only where a password is being chosen: sign-up and the reset screens', () => {
  assert.deepEqual(attrs(read('pages/auth/SignupPage.jsx'), 'PasswordInput'), [
    ['signup-password', 'new-password'],
    ['signup-confirm', 'new-password'],
  ]);
  const reset = read('pages/auth/ResetFields.jsx');
  assert.equal((reset.match(/autoComplete="new-password"/g) || []).length, 2, 'new password + its confirm field');
});

test('login and re-authentication fields are "off", so no generated-password prompt appears', () => {
  assert.deepEqual(attrs(read('pages/auth/LoginPage.jsx'), 'PasswordInput'), [['login-password', 'off']]);
  assert.deepEqual(attrs(read('pages/AccountPage.jsx'), 'PasswordInput'), [['delete-password', 'off']]);
  assert.deepEqual(attrs(read('pages/SharedDocumentPage.jsx'), 'PasswordInput'), [['share-view-password', 'off']]);
  // The shared field defaults to "off" and gives it a non-standard name.
  const input = read('pages/auth/PasswordInput.jsx');
  assert.match(input, /autoComplete = 'off'/);
  assert.match(input, /name=\{autoComplete === 'new-password' \? undefined : `wd-/);
  const field = read('components/PasswordField.jsx');
  assert.match(field, /autoComplete = 'off'/);
  assert.match(field, /name=\{autoComplete === 'new-password' \? undefined : `wd-/);
});

test('the email fields keep the no-autofill rules and the code boxes stay one-time-code', () => {
  const sensitive = read('components/SensitiveInput.jsx');
  assert.match(sensitive, /autoComplete="off"/);
  assert.match(sensitive, /name=\{`wd-\$\{fieldName\}-\$\{unique\}`\}/);
  assert.match(sensitive, /readOnly=\{!armed\}/);
  for (const file of ['pages/auth/LoginPage.jsx', 'pages/auth/SignupPage.jsx', 'pages/auth/ForgotPasswordPage.jsx']) {
    assert.match(read(file), /<SensitiveInput[^>]*type="email"/s, file);
  }
  assert.match(read('components/OtpCodeInput.jsx'), /autoComplete="one-time-code"/);
});

test('the auth screens use the two-column frame; the Account page opts out', () => {
  const layout = read('pages/auth/AuthLayout.jsx');
  assert.match(layout, /aria-hidden="true"/, 'the brand column is decorative');
  assert.match(layout, /layout = 'split'/);
  assert.match(read('pages/AccountPage.jsx'), /layout="stacked"/);
});
