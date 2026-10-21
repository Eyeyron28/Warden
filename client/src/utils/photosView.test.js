import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PHOTOS_VIEW_KEY, readPhotosView, writePhotosView } from './photosView.js';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fake = (value) => ({ getItem: (key) => (key === PHOTOS_VIEW_KEY ? value : null), setItem(key, next) { this.saved = [key, next]; } });

test('the Photos view is the list when nothing is stored, and the grid when "grid" is stored', () => {
  assert.equal(readPhotosView(fake(null)), 'list');
  assert.equal(readPhotosView(fake('list')), 'list');
  assert.equal(readPhotosView(fake('grid')), 'grid');
  assert.equal(readPhotosView(fake('anything else')), 'list');
  assert.equal(PHOTOS_VIEW_KEY, 'warden.photosView');
});

test('a blocked or throwing storage falls back to the list and never throws', () => {
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readPhotosView(broken), 'list');
  assert.equal(readPhotosView(null), 'list');
  assert.doesNotThrow(() => writePhotosView('grid', broken));
  assert.doesNotThrow(() => writePhotosView('grid', null));
  const store = fake(null);
  writePhotosView('grid', store);
  assert.deepEqual(store.saved, [PHOTOS_VIEW_KEY, 'grid']);
});

test('the Photos toolbar has the List and Grid buttons, and both views show the same items', () => {
  const page = fs.readFileSync(path.join(src, 'pages', 'PhotosPage.jsx'), 'utf8');
  assert.match(page, /aria-label="List view" aria-pressed=\{view === 'list'\}/);
  assert.match(page, /aria-label="Grid view" aria-pressed=\{view === 'grid'\}/);
  assert.match(page, /useState\(readPhotosView\)/);
  assert.match(page, /<FileBrowser items=\{group\.items\} view=\{view\}/);
});
