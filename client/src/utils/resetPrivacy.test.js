import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.join(here, '..', relative), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the forgot-password flow keeps secrets in memory only', () => {
  const page = read('pages/auth/ForgotPasswordPage.jsx');
  assert.doesNotMatch(page, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  // The only router state it ever sets is a harmless flag for the login page's message.
  assert.equal((page.match(/state:/g) || []).length, 1, 'one router-state use');
  assert.match(page, /state: \{ passwordReset: kind \}/);
  const kinds = [...page.matchAll(/finishAtLogin\('(\w+)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(kinds)].sort(), ['kept', 'wiped']);
  // Nothing secret goes into a URL, query string or hash.
  assert.doesNotMatch(page, /searchParams|location\.(search|hash)|\?ticket=|#ticket/);
});

test('the three secret inputs ask browsers not to autofill, in the right way', () => {
  const fields = read('pages/auth/ResetFields.jsx');
  assert.match(fields, /fieldName="recovery-secret"/, 'recovery key: no-autofill input');
  assert.match(fields, /autoComplete="new-password"/, 'passwords: new-password');
  const input = read('components/SensitiveInput.jsx');
  assert.match(input, /autoComplete="off"/);
  assert.match(input, /spellCheck=\{false\}/);
  assert.match(read('components/OtpCodeInput.jsx'), /autoComplete="one-time-code"/);
  assert.match(read('components/OtpCodeInput.jsx'), /inputMode="numeric"/);
});

test('the old emailed-link page does not read, send or show the token', () => {
  const page = read('pages/auth/ResetPasswordPage.jsx');
  assert.doesNotMatch(page, /token|searchParams|useSearchParams|authService/i);
});

test('the old reset service calls are gone', () => {
  const service = read('services/authService.js');
  assert.doesNotMatch(service, /auth\/forgot-password|auth\/reset-password['"`]/);
  for (const name of ['requestPasswordReset', 'verifyPasswordResetCode', 'resetPasswordWithRecoveryKey', 'resetPasswordStartOver', 'resetPasswordWithRecoveryKeyOnly']) {
    assert.match(service, new RegExp(`export async function ${name}`));
  }
});
