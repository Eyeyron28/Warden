import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { currentFirst, hasOverflow, inlineDevices, overflowCount } from './trustedBrowsers.js';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const component = () => fs.readFileSync(path.join(src, 'components/TrustedBrowsers.jsx'), 'utf8');

const make = (count, currentIndex = -1) =>
  Array.from({ length: count }, (_, i) => ({
    id: `d${i}`,
    label: `Browser ${i}`,
    current: i === currentIndex,
  }));

test('this browser always comes first, then the rest in their order', () => {
  const list = currentFirst(make(5, 3));
  assert.equal(list[0].id, 'd3');
  assert.deepEqual(
    list.slice(1).map((d) => d.id),
    ['d0', 'd1', 'd2', 'd4']
  );
});

test('at most three are shown inline, and the overflow count is right', () => {
  const six = make(6, 5);
  assert.deepEqual(
    inlineDevices(six).map((d) => d.id),
    ['d5', 'd0', 'd1']
  );
  assert.equal(overflowCount(six), 3);
  assert.equal(inlineDevices(make(2)).length, 2);
  assert.equal(inlineDevices([]).length, 0);
});

test('the view-all button is only for more than three', () => {
  assert.equal(hasOverflow(make(3)), false);
  assert.equal(hasOverflow(make(4)), true);
  assert.equal(overflowCount(make(3)), 0);
  assert.match(
    component(),
    /\{overflowing && \(\s*<button[^>]*onClick=\{\(\) => setShowAll\(true\)\}>\s*View all devices \(\{devices\.length\}\)/
  );
});

test('the modal uses the shared Modal, lists every browser, offers Remove all and closes itself when the list shrinks', () => {
  const text = component();
  assert.match(text, /lazy\(\(\) => import\('\.\/Modal\.jsx'\)\)/);
  assert.match(text, /showAll && devices && overflowing/);
  assert.match(text, /onClose=\{\(\) => setShowAll\(false\)\}/);
  assert.match(text, /footer=\{removeAll\}/);
  assert.match(text, /currentFirst\(devices\)\.map\(renderRow\)/);
  assert.match(text, /if \(devices && !hasOverflow\(devices\)\) setShowAll\(false\)/);
});

test('removing a browser in the modal reloads the shared list, so the card and the modal update together', () => {
  const text = component();
  assert.match(text, /onClick=\{\(\) => run\(\(\) => removeTrustedDevice\(device\.id\)\)\}/);
  assert.match(text, /await action\(\);\s*await load\(\);/);
  assert.equal((text.match(/renderRow/g) || []).length, 3);
});

test('an empty list says so', () => {
  assert.match(component(), /No trusted browsers yet\./);
});
