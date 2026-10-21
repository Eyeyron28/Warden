import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { selectExpired } from './expiredDocs.js';

const require = createRequire(import.meta.url);
const { daysUntil, expiryStatus } = require('../../../server/utils/docExpiry.js');

const now = new Date('2026-10-19T15:30:00Z');
const at = (offsetDays) => new Date(Date.UTC(2026, 9, 19 + offsetDays)).toISOString();

const docs = [
  { id: 'yesterday', filename: 'a', docExpiresAt: at(-1) },
  { id: 'long-ago', filename: 'b', docExpiresAt: at(-400) },
  { id: 'today', filename: 'c', docExpiresAt: at(0) },
  { id: 'tomorrow', filename: 'd', docExpiresAt: at(1) },
  { id: 'far', filename: 'e', docExpiresAt: at(300) },
  { id: 'no-date', filename: 'f', docExpiresAt: null },
  { id: 'trashed', filename: 'g', docExpiresAt: at(-30), deletedAt: at(-1) },
];

const healthCount = () => docs.filter((d) => !d.deletedAt && d.docExpiresAt).filter((d) => daysUntil(d.docExpiresAt, now) < 0).length;

const withStatus = () =>
  docs
    .filter((d) => !d.deletedAt && d.docExpiresAt)
    .map((d) => {
      const state = expiryStatus(d.docExpiresAt, now);
      return { ...d, expiryStatus: state === 'expired' ? 'expired' : state === 'soon' ? 'expiring_soon' : 'ok' };
    });
const overviewCount = () => withStatus().filter((d) => d.expiryStatus === 'expired').length;

test('Vault health, the Overview and the Expired documents page count the same documents', () => {
  const health = healthCount();
  const overview = overviewCount();
  assert.equal(health, 2);
  assert.equal(overview, health);
  assert.equal(selectExpired(withStatus(), now).length, health, 'the page, from the server list');
  assert.equal(selectExpired(docs, now).length, health, 'the page, from the stored days alone, Trash left out');
  assert.deepEqual(selectExpired(withStatus(), now).map((d) => d.id), ['long-ago', 'yesterday']);
});
