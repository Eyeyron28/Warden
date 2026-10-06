// Run with: cd client && npm test   (Node's built-in test runner, no deps)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertSameOrigin, sameOriginApiBase } from './apiOrigin.js';

const PAGE = 'https://192.168.1.50:5173';

// Hostile values an attacker might put in ?apiBase= (or plant in storage).
const HOSTILE = [
  'https://evil.example',
  'http://evil.example',
  'https://evil.example:5000',
  '//evil.example',
  '///evil.example',
  '\\evil.example',
  'https://192.168.1.50:5173@evil.example',
  'https://good.example@evil.example',
  'https://evil.example#@192.168.1.50:5173',
  'https://evil.example?@192.168.1.50:5173',
  'https://192.168.1.50:5173.evil.example',
  'https://evil.example/https://192.168.1.50:5173',
  'https://192.168.1.50:5174',
  'http://192.168.1.50:5173',
  'https://192.168.1.50:5173/evil',
  'https://user:pw@192.168.1.50:5173',
  'javascript:alert(1)',
  'data:text/html,hi',
  'evil.example',
  '',
  null,
  undefined,
];

test('sameOriginApiBase is the page origin and ignores query, hash and path', () => {
  const hostileQuery = [
    `${PAGE}/pair/tok?apiBase=https://evil.example`,
    `${PAGE}/pair/tok?apiBase=//evil.example`,
    `${PAGE}/pair/tok?apiBase=https://good.example@evil.example`,
    `${PAGE}/pair/tok#apiBase=https://evil.example`,
    `${PAGE}/pair/tok?apiBase=https%3A%2F%2Fevil.example`,
  ];
  for (const href of hostileQuery) {
    assert.equal(sameOriginApiBase(href), PAGE, href);
  }
  assert.equal(sameOriginApiBase('https://localhost:5173/pair/x'), 'https://localhost:5173');
});

test('assertSameOrigin rejects every hostile apiBase', () => {
  for (const value of HOSTILE) {
    assert.throws(() => assertSameOrigin(value, PAGE), /Refusing/, String(value));
  }
});

test('assertSameOrigin accepts exactly the page origin', () => {
  assert.equal(assertSameOrigin(PAGE, PAGE), PAGE);
  assert.equal(assertSameOrigin(`${PAGE}/`, PAGE), `${PAGE}/`);
});

// Source guard: nothing in the app may read an API base from the URL again.
function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(js|jsx)$/.test(name) && !name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

test('no source file reads apiBase from the URL or builds links carrying it', () => {
  const srcDir = fileURLToPath(new URL('..', import.meta.url));
  for (const file of sourceFiles(srcDir)) {
    // Comments may legitimately describe the old behaviour; scan code only.
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(text, /get\(\s*['"]apiBase['"]\s*\)/, `${file} reads apiBase from a query string`);
    assert.doesNotMatch(text, /[?&]apiBase=/, `${file} puts apiBase in a URL`);
    if (/(PairPage|PairDevicePanel)\.jsx$/.test(file)) {
      assert.doesNotMatch(text, /useSearchParams|location\.(search|hash)/, `${file} reads the URL query/hash`);
    }
  }
});
