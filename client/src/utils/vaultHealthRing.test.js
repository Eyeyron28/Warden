import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsx = fs.readFileSync(path.join(src, 'components', 'VaultHealthCard.jsx'), 'utf8');
const css = fs.readFileSync(path.join(src, 'components', 'VaultHealthCard.module.css'), 'utf8');

test('the ring is an image with the final score in its label, and the score text is the real score on first render', () => {
  assert.match(jsx, /role="img" aria-label=\{`Vault health score \$\{health\.score\} out of 100`\}/);
  assert.match(jsx, /data-testid="health-score">\s*\{health\.score\}\s*</);
  // The count-up is only a CSS counter drawn on top; the DOM text never depends on an animation or a timer.
  assert.match(css, /--n: var\(--score\);/);
  assert.doesNotMatch(jsx, /setInterval|setTimeout|requestAnimationFrame/);
});

test('the glow layers are hidden from assistive tech, and reduced motion shows a static ring', () => {
  assert.match(jsx, /className=\{styles\.arcGlow\}\s*aria-hidden="true"/);
  assert.match(jsx, /className=\{styles\.orbit\} aria-hidden="true"/);
  // All motion sits inside no-preference; the reduce block hides the orbit and keeps a steady glow.
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?animation: orbit 6s linear infinite;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.orbit \{\s*display: none;/);
  assert.doesNotMatch(css.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\r?\n\}\r?\n/, ''), /animation:\s*(draw|pulse|orbit|count)/);
});
