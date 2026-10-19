import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TYPE_WORDS } from '../components/site/typeWord.js';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');

test('the heading keeps its whole sentence, with "documents" in it', () => {
  const page = read('pages/public/HomePage.jsx').replace(/\s+/g, ' ');
  assert.match(page, /A vault for the <span>documents<\/span> you can&apos;t afford to lose, or leak\./);
});

test('the typed words are exactly these nine, starting with documents', () => {
  assert.deepEqual(TYPE_WORDS, ['documents', 'Valid IDs', 'Photos', 'Contracts', 'Receipts', 'Transcripts', 'Passports', 'Diplomas', 'Certificates']);
});

test('reduced motion: no typing and no blinking cursor; every timer is cleaned up', () => {
  const code = read('components/site/typeWord.js');
  assert.match(code, /prefers-reduced-motion: reduce/);
  assert.match(code, /clearTimeout\(timer\)/);
  assert.match(code, /visibilitychange/);
  assert.match(read('components/site/typeWord.css'), /@media \(prefers-reduced-motion: reduce\)[\s\S]*display: none/);
});
