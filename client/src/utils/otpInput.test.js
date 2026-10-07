// Run with: cd client && npm test   (Node's built-in test runner, no deps)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { backspaceAt, digitsOnly, emptyDigits, fillFrom, formatClock, isComplete, toCode } from './otpInput.js';

test('digitsOnly keeps ASCII digits and nothing else', () => {
  assert.equal(digitsOnly('12 34-56'), '123456');
  assert.equal(digitsOnly('abc'), '');
  assert.equal(digitsOnly('１２３'), '', 'full-width digits are not accepted');
  assert.equal(digitsOnly('<b>7</b>'), '7');
  assert.equal(digitsOnly(undefined), '');
  assert.equal(digitsOnly(null), '');
});

test('typing one digit fills the box and moves on', () => {
  const { digits, focusIndex } = fillFrom(emptyDigits(), 0, '4');
  assert.deepEqual(digits, ['4', '', '', '', '', '']);
  assert.equal(focusIndex, 1);
});

test('typing a non-digit changes nothing', () => {
  const start = emptyDigits();
  const { digits, focusIndex } = fillFrom(start, 2, 'x');
  assert.deepEqual(digits, start);
  assert.equal(focusIndex, 2);
});

test('pasting a whole code fills every box, from the first, whichever box had focus', () => {
  for (const index of [0, 3, 5]) {
    const { digits, focusIndex } = fillFrom(emptyDigits(), index, '123456');
    assert.equal(toCode(digits), '123456', `from box ${index}`);
    assert.equal(focusIndex, 5);
    assert.ok(isComplete(digits));
  }
  assert.equal(toCode(fillFrom(emptyDigits(), 2, '12 34 56').digits), '123456', 'spaces are ignored');
  assert.equal(toCode(fillFrom(emptyDigits(), 0, '1234567890').digits), '123456', 'extra digits are dropped');
});

test('a short paste spills forward from the box, not past the last one', () => {
  const { digits, focusIndex } = fillFrom(['1', '2', '', '', '', ''], 2, '345');
  assert.equal(toCode(digits), '12345');
  assert.equal(focusIndex, 5);
  const tail = fillFrom(emptyDigits(), 4, '789');
  assert.deepEqual(tail.digits, ['', '', '', '', '7', '8']);
});

test('backspace clears this box, or steps back and clears the previous one', () => {
  assert.deepEqual(backspaceAt(['1', '2', '3', '', '', ''], 2), { digits: ['1', '2', '', '', '', ''], focusIndex: 2 });
  assert.deepEqual(backspaceAt(['1', '2', '3', '', '', ''], 3), { digits: ['1', '2', '', '', '', ''], focusIndex: 2 });
  assert.deepEqual(backspaceAt(emptyDigits(), 0), { digits: emptyDigits(), focusIndex: 0 });
});

test('formatClock renders m:ss', () => {
  assert.equal(formatClock(300), '5:00');
  assert.equal(formatClock(61), '1:01');
  assert.equal(formatClock(9), '0:09');
  assert.equal(formatClock(-4), '0:00');
});

test('the login page keeps the challenge token in memory only', () => {
  const page = readFileSync(fileURLToPath(new URL('../pages/auth/LoginPage.jsx', import.meta.url)), 'utf8');
  const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.doesNotMatch(code, /navigate\([^)]*challenge/i, 'the token never goes into a URL or router state');
  assert.doesNotMatch(code, /console\./);
});
