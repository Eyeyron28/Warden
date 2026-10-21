import test from 'node:test';
import assert from 'node:assert/strict';

import { formatDate, formatDateTime } from './formatDate.js';

const SAMPLES = ['2026-10-14T06:40:10.405Z', '2026-01-01T00:00:00Z', '2025-12-31T23:59:59Z', new Date(2024, 1, 29, 13, 5), 1700000000000];

test('formatDate gives the same text as toLocaleDateString did', () => {
  for (const value of SAMPLES) {
    const expected = new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    assert.equal(formatDate(value), expected, String(value));
  }
});

test('formatDateTime gives the same text as toLocaleString did', () => {
  for (const value of SAMPLES) {
    const expected = new Date(value).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    assert.equal(formatDateTime(value), expected, String(value));
  }
});

test('empty and invalid values behave as before, and two files made on one day share one result', () => {
  assert.equal(formatDate(null), null);
  assert.equal(formatDate(''), null);
  assert.equal(formatDate('not a date'), 'Invalid Date');
  assert.equal(formatDateTime(undefined), null);
  assert.equal(formatDateTime('nope'), 'Invalid Date');
  assert.equal(formatDate(new Date(2026, 5, 1, 8, 0)), formatDate(new Date(2026, 5, 1, 21, 30)));
  assert.notEqual(formatDate(new Date(2026, 5, 1)), formatDate(new Date(2026, 5, 2)));
});

test('a long list of dates is fast (the formatter is built once, not per call)', () => {
  const started = performance.now();
  for (let i = 0; i < 20000; i += 1) formatDate(new Date(2026, 0, 1 + (i % 365), i % 24));
  assert.ok(performance.now() - started < 400, `20,000 dates took ${(performance.now() - started).toFixed(0)} ms`);
});
