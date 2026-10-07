import test from 'node:test';
import assert from 'node:assert/strict';

import { describeUsage, uploadFitsMessage } from './storageUsage.js';

const MB = 1024 * 1024;
const usage = (files, trash, quota = 25) => ({
  fileBytes: files * MB,
  trashBytes: trash * MB,
  usedBytes: (files + trash) * MB,
  quotaBytes: quota * MB,
  availableBytes: Math.max(0, (quota - files - trash) * MB),
});

test('the meter bar is files + Trash as shares of the quota', () => {
  const view = describeUsage(usage(10, 5));
  assert.equal(view.filesPercent, 40);
  assert.equal(view.trashPercent, 20);
  assert.equal(view.usedPercent, 60);
  assert.equal(view.nearlyFull, false);
  assert.match(view.summary, /15 MB of 25 MB used: 10 MB in files, 5\.0 MB in Trash/);
});

test('it warns near and at the limit and never draws past 100%', () => {
  assert.equal(describeUsage(usage(20, 3)).nearlyFull, true);
  const full = describeUsage(usage(25, 5));
  assert.equal(full.full, true);
  assert.ok(full.filesPercent + full.trashPercent <= 100.0001);
  assert.equal(describeUsage({ fileBytes: 0, trashBytes: 0, usedBytes: 0, quotaBytes: 0 }).usedPercent, 0);
});

test('the upload pre-check refuses what cannot fit and names the numbers', () => {
  assert.equal(uploadFitsMessage(usage(10, 5), 4 * MB), null);
  const message = uploadFitsMessage(usage(20, 4), 3 * MB);
  assert.match(message, /Not enough storage/);
  assert.match(message, /3\.0 MB/);
  assert.match(message, /empty Trash/i);
  assert.equal(uploadFitsMessage(null, 99 * MB), null, 'with no numbers the server decides');
});
