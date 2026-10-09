import test from 'node:test';
import assert from 'node:assert/strict';

import { expiryBadge, expiryDayValue, expiryPhrase, formatExpiryDay } from './expiry.js';

test('the day comes straight from the ISO string, with no time-zone shift', () => {
  assert.equal(expiryDayValue('2027-03-05T00:00:00.000Z'), '2027-03-05');
  assert.equal(expiryDayValue(null), '');
  assert.equal(expiryDayValue('soon'), '');
  assert.equal(formatExpiryDay('2027-03-05T00:00:00.000Z'), 'Mar 5, 2027');
  assert.equal(formatExpiryDay('2026-12-31T00:00:00.000Z'), 'Dec 31, 2026');
  assert.equal(formatExpiryDay(''), '');
});

test('the list badge: red once expired, amber under 60 days (the server decides), nothing otherwise', () => {
  assert.deepEqual(expiryBadge({ expiryStatus: 'expired', daysUntilExpiry: -2 }), { label: 'Expired', tone: 'danger' });
  assert.deepEqual(expiryBadge({ expiryStatus: 'expiring_soon', daysUntilExpiry: 0 }), { label: 'Expires today', tone: 'warning' });
  assert.deepEqual(expiryBadge({ expiryStatus: 'expiring_soon', daysUntilExpiry: 1 }), { label: 'Expires in 1 day', tone: 'warning' });
  assert.deepEqual(expiryBadge({ expiryStatus: 'expiring_soon', daysUntilExpiry: 59 }), { label: 'Expires in 59 days', tone: 'warning' });
  assert.equal(expiryBadge({ expiryStatus: 'ok', daysUntilExpiry: 90 }), null);
  assert.equal(expiryBadge({}), null);
  assert.equal(expiryBadge(null), null);
});

test('the sentence for the Overview card', () => {
  assert.equal(expiryPhrase({ daysUntilExpiry: -1, docExpiresAt: '2026-10-08T00:00:00.000Z' }), 'Expired 1 day ago');
  assert.equal(expiryPhrase({ daysUntilExpiry: -9 }), 'Expired 9 days ago');
  assert.equal(expiryPhrase({ daysUntilExpiry: 0 }), 'Expires today');
  assert.equal(expiryPhrase({ daysUntilExpiry: 12, docExpiresAt: '2026-10-21T00:00:00.000Z' }), 'Expires in 12 days (Oct 21, 2026)');
  assert.equal(expiryPhrase({}), '');
});
