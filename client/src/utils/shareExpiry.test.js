import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_EXPIRY_DAYS,
  EXPIRY_PRESET_DAYS,
  MAX_EXPIRY_DAYS,
  customDaysProblem,
  dayLabel,
  daysToHours,
  maxDaysUntil,
} from './shareExpiry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.join(here, '..', relative), 'utf8');

test('the choices are 1, 3, 7, 14 and 30 days, 7 by default, never hours', () => {
  assert.deepEqual(EXPIRY_PRESET_DAYS, [1, 3, 7, 14, 30]);
  assert.equal(DEFAULT_EXPIRY_DAYS, 7);
  assert.equal(MAX_EXPIRY_DAYS, 30);
  assert.deepEqual(EXPIRY_PRESET_DAYS.map(dayLabel), ['1 day', '3 days', '7 days', '14 days', '30 days']);
  assert.equal(daysToHours(7), 168);
});

test('custom days: a whole number from 1 to 30, with a clear message otherwise', () => {
  for (const ok of ['1', '15', '30', ' 7 ']) assert.equal(customDaysProblem(ok), '', ok);
  assert.match(customDaysProblem(''), /Enter a number of days/);
  for (const bad of ['0', '31', '100']) assert.match(customDaysProblem(bad), /Choose from 1 to 30 days/, bad);
  for (const bad of ['1.5', '-3', 'abc', '1e1', '+4']) assert.match(customDaysProblem(bad), /whole number of days, from 1 to 30/, bad);
  assert.match(customDaysProblem('12', 10), /from 1 to 10/);
});

test('the manager can only offer what is left of the 30 days', () => {
  const now = Date.UTC(2026, 9, 8);
  const day = 24 * 3600 * 1000;
  assert.equal(maxDaysUntil(now + 30 * day, now), 30);
  assert.equal(maxDaysUntil(now + 29.5 * day, now), 29);
  assert.equal(maxDaysUntil(now + 0.5 * day, now), 0);
  assert.equal(maxDaysUntil(now - day, now), 0);
  assert.equal(maxDaysUntil(now + 90 * day, now), 30, 'never more than the cap');
});

test('neither share dialog offers hours, a date picker or a date-time input', () => {
  for (const file of ['components/ShareModal.jsx', 'components/ShareEditModal.jsx']) {
    const source = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(source, /'1 hour'|'24 hours'|hours: \d|datetime-local|getNowDateTimeInputValue/, file);
    assert.match(source, /EXPIRY_PRESET_DAYS/, file);
    assert.match(source, /type="number"/, file);
  }
  assert.match(read('components/ShareModal.jsx'), /useState\(DEFAULT_EXPIRY_DAYS\)/);
});
