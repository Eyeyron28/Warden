// Run with: cd client && npm test   (Node's built-in test runner, no deps)
import test from 'node:test';
import assert from 'node:assert/strict';

import { safeRedirectPath, isSafeRedirectPath } from './safeRedirect.js';

const SAFE = [
  '/',
  '/vault',
  '/login',
  '/vault?folder=Taxes',
  '/privacy#deleting',
  '/#about',
  '/a/b/c',
  '/files/my%20file.pdf',
  '/search?q=a%26b',
  '/path-with-dash_and.dots',
  '/@handle',
];

const HOSTILE = [
  // The ones from the advisory / the task
  ['protocol-relative', '//evil.com'],
  ['backslash after slash', '/\\evil.com'],
  ['absolute https URL', 'https://evil.com'],
  ['javascript: URL', 'javascript:alert(1)'],
  ['encoded protocol-relative', '%2F%2Fevil.com'],
  ['encoded backslash after slash', '/%5Cevil.com'],
  // Variations
  ['double backslash', '\\\\evil.com'],
  ['leading backslash', '\\evil.com'],
  ['triple slash', '///evil.com'],
  ['slash then encoded slash', '/%2Fevil.com'],
  ['slash then encoded slash, upper/lower', '/%2fevil.com'],
  ['double-encoded protocol-relative', '%252F%252Fevil.com'],
  ['double-encoded after a slash', '/%252F%252Fevil.com'],
  ['triple-encoded after a slash', '/%25252Fevil.com'],
  ['double-encoded backslash', '/%255Cevil.com'],
  ['tab between slashes', '/\t/evil.com'],
  ['encoded tab between slashes', '/%09/evil.com'],
  ['newline between slashes', '/\n/evil.com'],
  ['encoded CRLF', '/%0d%0a/evil.com'],
  ['encoded NUL', '/%00/evil.com'],
  ['leading space', ' //evil.com'],
  ['leading space before a path', ' /vault'],
  ['trailing space', '/vault '],
  ['leading tab', '\t//evil.com'],
  ['absolute http URL', 'http://evil.com'],
  ['scheme-relative host', 'evil.com'],
  ['bare path without a slash', 'vault'],
  ['data: URL', 'data:text/html,<script>alert(1)</script>'],
  ['vbscript: URL', 'vbscript:msgbox(1)'],
  ['mixed-case javascript:', 'JaVaScRiPt:alert(1)'],
  ['encoded javascript:', 'javascript%3Aalert(1)'],
  ['userinfo trick', 'https://warden.example@evil.com'],
  ['slash-backslash-slash', '/\\/evil.com'],
  ['backslash later in the path', '/safe\\..\\evil.com'],
  ['malformed percent sequence', '/%zz'],
  ['lone percent', '/%'],
  ['truncated percent', '/abc%2'],
  ['dot-dot with encoded backslash', '/..%5C..%5Cevil.com'],
  ['empty string', ''],
  ['only a hash', '#frag'],
  ['only a query', '?x=1'],
  ['not a string: null', null],
  ['not a string: undefined', undefined],
  ['not a string: number', 5],
  ['not a string: object', { toString: () => '/vault' }],
  ['not a string: array', ['/vault']],
  ['over 2048 characters', `/${'a'.repeat(2048)}`],
];

for (const path of SAFE) {
  test(`allows same-origin path ${JSON.stringify(path)}`, () => {
    assert.equal(isSafeRedirectPath(path), true);
    assert.equal(safeRedirectPath(path), path, 'returned unchanged, never rewritten or decoded');
  });
}

for (const [name, value] of HOSTILE) {
  test(`rejects ${name}: ${JSON.stringify(typeof value === 'string' ? value.slice(0, 40) : value)}`, () => {
    assert.equal(isSafeRedirectPath(value), false);
    assert.equal(safeRedirectPath(value), '/');
  });
}

test('uses the fallback you give it', () => {
  assert.equal(safeRedirectPath('//evil.com', '/vault'), '/vault');
  assert.equal(safeRedirectPath('/\\evil.com', '/vault'), '/vault');
  assert.equal(safeRedirectPath(undefined, '/vault'), '/vault');
  assert.equal(safeRedirectPath('/login', '/vault'), '/login');
});

test('a path of exactly 2048 characters is the longest accepted', () => {
  assert.equal(isSafeRedirectPath(`/${'a'.repeat(2047)}`), true);
  assert.equal(isSafeRedirectPath(`/${'a'.repeat(2048)}`), false);
});
