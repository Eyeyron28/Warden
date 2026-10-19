import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDragCounter, hasFiles } from './fileDrag.js';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');

test('only a drag that carries files counts (not text, and not an in-app drag)', () => {
  assert.equal(hasFiles({ dataTransfer: { types: ['Files'] } }), true);
  assert.equal(hasFiles({ dataTransfer: { types: ['text/plain', 'Files'] } }), true);
  assert.equal(hasFiles({ dataTransfer: { types: ['text/plain'] } }), false);
  assert.equal(hasFiles({ dataTransfer: { types: ['application/x-warden-doc'] } }), false);
  assert.equal(hasFiles({}), false);
  assert.equal(hasFiles(null), false);
});

test('the counter stays on until every enter has its leave, and reset clears it at once', () => {
  const counter = createDragCounter();
  assert.equal(counter.active, false);
  assert.equal(counter.enter(), true);
  assert.equal(counter.enter(), true);
  assert.equal(counter.leave(), true, 'one leave of two: still over the zone');
  assert.equal(counter.leave(), false, 'both left');
  assert.equal(counter.leave(), false, 'an extra leave never goes below zero');
  counter.enter();
  counter.enter();
  assert.equal(counter.reset(), false, 'drop or dragend');
  assert.equal(counter.active, false);
});

test('the drop zones share the hook, and the app ignores a dropped file anywhere else', () => {
  for (const file of ['pages/FilesPage.jsx', 'components/UploadForm.jsx', 'components/ImportDropZone.jsx']) {
    assert.match(read(file), /useFileDrag\(/, file);
  }
  const hook = read('utils/useFileDrag.js');
  for (const event of ['dragend', 'drop', 'blur', 'visibilitychange', 'dragleave', 'Escape']) assert.ok(hook.includes(event), event);
  const layout = read('components/AppLayout.jsx');
  assert.match(layout, /window\.addEventListener\('dragover', guard\)/);
  assert.match(layout, /window\.removeEventListener\('drop', guard\)/);
});
