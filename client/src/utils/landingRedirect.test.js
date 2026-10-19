import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');
const app = read('App.jsx');
const gate = /function LandingGate[\s\S]*?\r?\n\}\r?\n/.exec(app)?.[0] ?? '';

test('a valid session sends the landing page to the login target, with replace', () => {
  assert.match(gate, /if \(token && !mode\.emergency && result === 'valid'\) return <Navigate to="\/files" replace \/>/);
  assert.match(app, /<Route index element=\{<LandingGate><HomePage \/><\/LandingGate>\} \/>/);
  assert.match(read('pages/auth/LoginPage.jsx'), /return <Navigate to="\/files" replace \/>/);
});

test('the landing page renders as it is while checking, signed out, expired or unverified', () => {
  assert.match(gate, /return children;/);
  assert.doesNotMatch(gate, /Skeleton|Spinner|return null/);
  // Only 'valid' redirects; the other outcomes (none, expired, unverified) and "still checking" (null) fall through.
  assert.equal((gate.match(/result ===/g) || []).length, 1);
});

test('nobody without a session triggers a server call, and a log out leaves the landing page alone', () => {
  assert.match(gate, /getToken\(\) \|\| adoptTokenFromOtherTabs\(\)/);
  assert.match(gate, /\.then\(\(held\) => held && checkSessionOnce\(\)\)/);
  // The log out clears the token first; the redirect needs a token.
  assert.match(app, /finally \{[\s\S]*?clearToken\(\);/);
  assert.match(gate, /if \(token &&/);
});

test('Login and Sign up already send a signed-in visitor to the dashboard', () => {
  assert.match(read('pages/auth/LoginPage.jsx'), /if \(token && !emergency\.emergency && !submitting && !challenge\) return <Navigate to="\/files" replace \/>/);
  assert.match(read('pages/auth/SignupPage.jsx'), /if \(token && step !== 'key'\) return <Navigate to="\/files" replace \/>/);
});
