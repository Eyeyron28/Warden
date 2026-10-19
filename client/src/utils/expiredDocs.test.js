import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { selectExpired } from './expiredDocs.js';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');
const now = new Date('2026-10-19T15:30:00Z');
const doc = (name, day, extra = {}) => ({ id: name, filename: name, docExpiresAt: day ? `${day}T00:00:00.000Z` : null, ...extra });

test('expired means before today in UTC days: yesterday yes, today and tomorrow no, no date no', () => {
  const list = [doc('today', '2026-10-19'), doc('yesterday', '2026-10-18'), doc('tomorrow', '2026-10-20'), doc('none', null)];
  assert.deepEqual(selectExpired(list, now).map((d) => d.id), ['yesterday']);
});

test('the server status wins when it is there, Trash is left out and the oldest expiry comes first', () => {
  const list = [
    doc('b-newer', '2026-10-10', { expiryStatus: 'expired' }),
    doc('a-older', '2026-01-02', { expiryStatus: 'expired' }),
    doc('soon', '2026-10-25', { expiryStatus: 'expiring_soon' }),
    doc('trashed', '2026-02-01', { expiryStatus: 'expired', deletedAt: '2026-10-01T00:00:00Z' }),
    doc('same-day-z', '2026-10-10', { expiryStatus: 'expired' }),
  ];
  assert.deepEqual(selectExpired(list, now).map((d) => d.id), ['a-older', 'b-newer', 'same-day-z']);
  assert.deepEqual(selectExpired(null, now), []);
});

test('the Expired documents route is guarded like the other app pages, and the sidebar and health fix point to it', () => {
  const app = read('App.jsx');
  const guarded = app.slice(app.indexOf('<RequireSession>'), app.indexOf('<Route path="/vault"'));
  assert.match(guarded, /<Route path="\/expired" element=\{<ExpiredPage \/>\} \/>/);
  assert.match(app, /const ExpiredPage = lazy\(\(\) => import\('\.\/pages\/OverviewPage\.jsx'\)\.then/);
  assert.match(read('pages/OverviewPage.jsx'), /export \{ default as ExpiredPage \} from '\.\/ExpiredPage\.jsx'/);
  const sidebar = read('components/Sidebar.jsx');
  assert.match(sidebar, /<NavLink to="\/expired"[\s\S]*?label\('Expired documents'\)/);
  assert.ok(sidebar.indexOf("label('Devices & activity')") < sidebar.indexOf("label('Expired documents')") && sidebar.indexOf("label('Expired documents')") < sidebar.indexOf("label('Export / Import')"));
  assert.match(read('components/VaultHealthCard.jsx'), /item\.id === 'expired_docs' \? '\/expired' : item\.actionPath/);
});
