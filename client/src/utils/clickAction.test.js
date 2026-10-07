import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rowClickAction } from './clickAction.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('clicking a file opens its preview and a folder opens the folder', () => {
  assert.equal(rowClickAction({ kind: 'file' }), 'open-preview');
  assert.equal(rowClickAction({ kind: 'folder' }), 'open-folder');
});

test('on the checkbox it selects; with modifiers it selects; elsewhere it still opens', () => {
  assert.equal(rowClickAction({ kind: 'file' }, { onCheckbox: true }), 'toggle');
  assert.equal(rowClickAction({ kind: 'file' }, { onCheckbox: true, shift: true }), 'range');
  assert.equal(rowClickAction({ kind: 'file' }, { shift: true }), 'range');
  assert.equal(rowClickAction({ kind: 'folder' }, { ctrl: true }), 'toggle');
  assert.equal(rowClickAction({ kind: 'file' }, { meta: true }), 'toggle');
  assert.equal(rowClickAction({ kind: 'trash-file' }), 'toggle', 'nothing to open in Trash');
});

test('no click, with any modifier or item kind, ever downloads', () => {
  const allowed = new Set(['open-folder', 'open-preview', 'toggle', 'range']);
  for (const kind of ['file', 'folder', 'trash-file', 'trash-folder']) {
    for (const onCheckbox of [false, true]) {
      for (const shift of [false, true]) {
        for (const ctrl of [false, true]) {
          for (const meta of [false, true]) {
            assert.ok(allowed.has(rowClickAction({ kind }, { onCheckbox, shift, ctrl, meta })));
          }
        }
      }
    }
  }
});

test('the click surface of the file views has no download or open-in-new-tab code at all', () => {
  const browser = strip(fs.readFileSync(path.join(src, 'components', 'FileBrowser.jsx'), 'utf8'));
  assert.doesNotMatch(browser, /download|openBlob|window\.open|createObjectURL/i);
  // The old "open the decrypted file in a new tab" helper is gone everywhere.
  for (const dir of ['components', 'pages', 'services', 'utils']) {
    for (const name of fs.readdirSync(path.join(src, dir))) {
      if (!/\.jsx?$/.test(name) || name.endsWith('.test.js')) continue;
      assert.doesNotMatch(fs.readFileSync(path.join(src, dir, name), 'utf8'), /\bopenBlob\b/, `${dir}/${name}`);
    }
  }
});

test('downloading is reachable only from explicit Download controls', () => {
  const callers = [];
  for (const dir of ['components', 'pages']) {
    for (const name of fs.readdirSync(path.join(src, dir))) {
      if (!/\.jsx$/.test(name)) continue;
      const text = strip(fs.readFileSync(path.join(src, dir, name), 'utf8'));
      if (/\bdownloadBytes\(/.test(text)) callers.push(`${dir}/${name}`);
    }
  }
  assert.deepEqual(callers.sort(), ['components/FilePreview.jsx', 'pages/FilesPage.jsx', 'pages/PhotosPage.jsx']);
  // ...and in each one only inside a function named like a download action.
  for (const file of callers) {
    const text = strip(fs.readFileSync(path.join(src, file), 'utf8'));
    for (const match of text.matchAll(/downloadBytes\(/g)) {
      const before = text.slice(Math.max(0, match.index - 900), match.index);
      assert.match(before, /(?:const|function)\s+(?:handle\w*Download\w*|download\w*)\s*[=(]/, `${file}: downloadBytes is not inside a download handler`);
    }
  }
});

test('a menu portaled out of a row cannot click the row (React events bubble through portals)', () => {
  const panel = fs.readFileSync(path.join(src, 'components', 'MenuPanel.jsx'), 'utf8');
  assert.match(panel, /onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(panel, /createPortal/);
});
