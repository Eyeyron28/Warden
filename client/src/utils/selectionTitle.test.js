import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');

test('the page title is rendered with and without a selection; only the controls become the selection bar', () => {
  for (const page of ['FilesPage', 'PhotosPage', 'TrashPage']) {
    const text = read(`pages/${page}.jsx`);
    const toolbar = text.indexOf('toolbarSelecting');
    const title = text.indexOf('styles.titleBlock', toolbar);
    const bar = text.indexOf('<SelectionBar', toolbar);
    assert.ok(toolbar > -1 && title > toolbar, `${page}: the toolbar holds the title`);
    assert.ok(title < bar, `${page}: the title comes before, and outside, the selection branch`);
    assert.equal((text.match(/<SelectionBar/g) || []).length, 1, page);
    assert.doesNotMatch(text.slice(0, toolbar).slice(-200), /selection\.count > 0 \? \(\s*$/, `${page}: the title is not inside the ternary`);
  }
});
