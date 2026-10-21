import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CARD_ROWS, firstFive } from './firstFive.js';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = fs.readFileSync(path.join(src, 'pages', 'OverviewPage.jsx'), 'utf8');

test('a card shows the first five and says whether there are more', () => {
  const make = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i) }));
  assert.equal(CARD_ROWS, 5);
  assert.deepEqual([0, 3, 5, 6, 50].map((n) => { const r = firstFive(make(n)); return [r.shown.length, r.more, r.total]; }), [[0, false, 0], [3, false, 3], [5, false, 5], [5, true, 6], [5, true, 50]]);
  assert.deepEqual(firstFive(make(6)).shown.map((d) => d.id), ['0', '1', '2', '3', '4']);
  assert.deepEqual(firstFive(null), { shown: [], more: false, total: 0 });
});

test('"View all" renders only above five rows, and the dialog uses the same rows', () => {
  assert.match(page, /\{more && \(\s*<button type="button" className=\{styles\.viewAll\}/);
  assert.match(page, /View all \(\{total\}\)/);
  assert.match(page, /<FileRows items=\{viewAll\.items\}/);
  assert.match(page, /<Modal title=\{`\$\{viewAll\.title\} \(\$\{viewAll\.items\.length\}\)`\} onClose=\{\(\) => setViewAll\(null\)\}>/);
  assert.match(page, /onPick=\{\(\) => setViewAll\(null\)\}/);
});
