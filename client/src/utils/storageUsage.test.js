import test from 'node:test';
import assert from 'node:assert/strict';

import { uploadFitsMessage } from './storageUsage.js';

const MB = 1024 * 1024;
const usage = (files, trash, quota = 25) => ({
  fileBytes: files * MB,
  trashBytes: trash * MB,
  usedBytes: (files + trash) * MB,
  quotaBytes: quota * MB,
  availableBytes: Math.max(0, (quota - files - trash) * MB),
});

test('the upload pre-check refuses what cannot fit, names the need and says what to do', () => {
  assert.equal(uploadFitsMessage(usage(10, 5), 4 * MB), null);
  const message = uploadFitsMessage(usage(20, 3), 3 * MB);
  assert.match(message, /Not enough storage/);
  assert.match(message, /3\.0 MB/);
  assert.match(message, /2\.0 MB is free/);
  assert.match(message, /Delete files or empty Trash/i);
  assert.equal(uploadFitsMessage(null, 99 * MB), null, 'with no numbers the server decides');
});

test('a full account is told so plainly, never "0.0 MB"', () => {
  const full = uploadFitsMessage(usage(25, 0), 1 * MB);
  assert.match(full, /^Your storage is full\./);
  assert.match(full, /empty Trash/i);
  assert.doesNotMatch(full, /0\.0 MB|only 0/);
});
