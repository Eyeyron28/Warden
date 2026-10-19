import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_INPUT_BYTES, SHRINK_STEPS, canShrink, isShrinkablePhoto, shrinkName, shrinkTarget, stepSize } from './shrinkPlan.js';
import { MAX_FILE_BYTES } from './transferRules.js';
import { addFiles, replaceFile } from './uploadSelection.js';

const photo = (name, size, type = 'image/jpeg') => ({ name, size, type, lastModified: 1 });

test('the steps go quality first, then smaller pictures, and the target is 90 percent of the limit', () => {
  assert.deepEqual(SHRINK_STEPS.slice(0, 4).map((s) => s.quality), [0.85, 0.75, 0.65, 0.55]);
  assert.ok(SHRINK_STEPS.slice(0, 4).every((s) => s.maxSide === null));
  assert.deepEqual(SHRINK_STEPS.slice(4).map((s) => s.maxSide), [4000, 3000, 2400, 1800]);
  assert.ok(SHRINK_STEPS.slice(4).every((s) => s.quality === 0.75));
  assert.equal(shrinkTarget(4 * 1024 * 1024), Math.floor(4 * 1024 * 1024 * 0.9));
});

test('a step never enlarges a picture and keeps its proportions', () => {
  assert.deepEqual(stepSize(6000, 4000, null), { width: 6000, height: 4000 });
  assert.deepEqual(stepSize(1200, 800, 4000), { width: 1200, height: 800 });
  assert.deepEqual(stepSize(6000, 4000, 3000), { width: 3000, height: 2000 });
  assert.deepEqual(stepSize(4000, 6000, 1800), { width: 1200, height: 1800 });
});

test('the new name is the base name with .jpg and never reads as a double extension', () => {
  assert.equal(shrinkName('passport.png'), 'passport.jpg');
  assert.equal(shrinkName('IMG 0042.JPEG'), 'IMG 0042.jpg');
  assert.equal(shrinkName('trip.2026.final.webp'), 'trip-2026-final.jpg');
  assert.equal(shrinkName('scan.exe.png'), 'scan-exe.jpg');
  assert.equal(shrinkName('no-extension'), 'no-extension.jpg');
  assert.equal(shrinkName('  '), 'photo.jpg');
  assert.equal(shrinkName('.png'), 'photo.jpg');
});

test('only a JPEG, PNG or WebP over the limit, and not absurdly large, can be made smaller', () => {
  const limit = MAX_FILE_BYTES;
  assert.equal(canShrink(photo('a.jpg', limit + 1), limit), true);
  assert.equal(canShrink(photo('a.png', 8 * limit, 'image/png'), limit), true);
  assert.equal(canShrink(photo('a.webp', limit + 1, 'image/webp'), limit), true);
  assert.equal(canShrink(photo('a.jpg', limit), limit), false, 'already within the limit');
  assert.equal(canShrink(photo('a.jpg', MAX_INPUT_BYTES + 1), limit), false, 'over 60 MB');
  assert.equal(canShrink(photo('a.gif', limit + 1, 'image/gif'), limit), false);
  assert.equal(canShrink(photo('a.pdf', limit + 1, 'application/pdf'), limit), false);
  assert.equal(canShrink(photo('a.zip', limit + 1, 'application/zip'), limit), false);
  assert.equal(isShrinkablePhoto(photo('scan.PNG', 1, '')), true, 'no type: the extension decides');
  assert.equal(isShrinkablePhoto(photo('notes.txt', 1, '')), false);
});

test('a smaller version replaces the file in its row and the row is checked again', () => {
  const { items } = addFiles([], [photo('big.png', MAX_FILE_BYTES + 5, 'image/png'), photo('ok.pdf', 100, 'application/pdf')]);
  assert.equal(items[0].error, 'Over 4 MB');
  const swapped = replaceFile(items, items[0].id, photo('big.jpg', 2 * 1024 * 1024));
  assert.equal(swapped[0].error, '');
  assert.equal(swapped[0].file.name, 'big.jpg');
  assert.equal(swapped[1], items[1]);
});
