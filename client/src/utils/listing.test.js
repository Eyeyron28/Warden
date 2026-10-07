import test from 'node:test';
import assert from 'node:assert/strict';

import { formatBytes, groupByMonth, sortItems } from './listing.js';
import { getViewPrefs, setViewPref } from './viewPrefs.js';

const file = (name, extra = {}) => ({ kind: 'file', name, size: 1, modified: '2026-01-01T00:00:00Z', ...extra });
const names = (items) => items.map((i) => i.name);

test('folders always come first', () => {
  const items = [file('b.txt'), { kind: 'folder', name: 'Zeta' }, file('a.txt'), { kind: 'folder', name: 'Alpha' }];
  assert.deepEqual(names(sortItems(items, 'name-asc')), ['Alpha', 'Zeta', 'a.txt', 'b.txt']);
  assert.deepEqual(names(sortItems(items, 'name-desc')), ['Zeta', 'Alpha', 'b.txt', 'a.txt']);
});

test('sorting by date and size', () => {
  const items = [
    file('old', { modified: '2025-01-01T00:00:00Z', size: 5 }),
    file('new', { modified: '2026-06-01T00:00:00Z', size: 1 }),
    file('mid', { modified: '2025-09-01T00:00:00Z', size: 9 }),
  ];
  assert.deepEqual(names(sortItems(items, 'newest')), ['new', 'mid', 'old']);
  assert.deepEqual(names(sortItems(items, 'oldest')), ['old', 'mid', 'new']);
  assert.deepEqual(names(sortItems(items, 'size-desc')), ['mid', 'old', 'new']);
  assert.deepEqual(names(sortItems(items, 'size-asc')), ['new', 'old', 'mid']);
});

test('newest still lifts expiring documents to the top', () => {
  const items = [
    file('plain', { modified: '2026-06-01T00:00:00Z', document: { expiryStatus: 'ok' } }),
    file('soon', { modified: '2025-01-01T00:00:00Z', document: { expiryStatus: 'expiring_soon', daysUntilExpiry: 3 } }),
    file('expired', { modified: '2025-02-01T00:00:00Z', document: { expiryStatus: 'expired', daysUntilExpiry: -2 } }),
  ];
  assert.deepEqual(names(sortItems(items, 'newest')), ['expired', 'soon', 'plain']);
});

test('photos are grouped by month in the order given', () => {
  const photos = [
    { id: 1, createdAt: '2026-10-20T12:00:00' },
    { id: 2, createdAt: '2026-10-02T12:00:00' },
    { id: 3, createdAt: '2026-08-15T12:00:00' },
  ];
  const groups = groupByMonth(photos, 'en-US');
  assert.deepEqual(groups.map((g) => [g.label, g.items.map((p) => p.id)]), [['October 2026', [1, 2]], ['August 2026', [3]]]);
  assert.deepEqual(groupByMonth([], 'en-US'), []);
});

test('sizes read naturally', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
  assert.equal(formatBytes(NaN), '');
});

test('view preferences live in memory and reject junk', () => {
  setViewPref('view', 'grid');
  setViewPref('sort', 'name-asc');
  setViewPref('view', 'carousel');
  assert.deepEqual(getViewPrefs(), { view: 'grid', sort: 'name-asc' });
});
