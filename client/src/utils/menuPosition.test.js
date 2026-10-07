import test from 'node:test';
import assert from 'node:assert/strict';

import { placeAtPoint, placeBelow } from './menuPosition.js';

const viewport = { width: 1000, height: 700 };
const size = { width: 220, height: 260 };

const inside = (box, s, v = viewport, margin = 8) =>
  box.left >= margin && box.top >= margin && box.left + Math.min(s.width, v.width) <= v.width - margin + 0.001 &&
  box.top + Math.min(s.height, box.maxHeight) <= v.height - margin + 0.001;

test('a context menu opens at the pointer, down and to the right', () => {
  const box = placeAtPoint({ x: 100, y: 120 }, size, viewport);
  assert.deepEqual([box.left, box.top, box.flippedX, box.flippedY], [100, 120, false, false]);
});

test('it flips left near the right edge and up near the bottom edge', () => {
  const right = placeAtPoint({ x: 950, y: 100 }, size, viewport);
  assert.equal(right.flippedX, true);
  assert.equal(right.left, 950 - 220);
  const bottom = placeAtPoint({ x: 100, y: 650 }, size, viewport);
  assert.equal(bottom.flippedY, true);
  assert.equal(bottom.top, 650 - 260);
  const corner = placeAtPoint({ x: 995, y: 695 }, size, viewport);
  assert.ok(corner.flippedX && corner.flippedY && inside(corner, size));
});

test('it always stays inside the viewport, wherever the pointer is', () => {
  for (const x of [0, 5, 500, 999, 1000]) {
    for (const y of [0, 5, 350, 699, 700]) {
      const box = placeAtPoint({ x, y }, size, viewport);
      assert.ok(inside(box, size), `${x},${y} -> ${JSON.stringify(box)}`);
    }
  }
});

test('a menu taller than the screen is capped and pinned to the top margin', () => {
  const box = placeAtPoint({ x: 100, y: 300 }, { width: 220, height: 2000 }, viewport);
  assert.equal(box.maxHeight, 700 - 16);
  assert.equal(box.top, 8);
});

test('a narrow phone viewport still fits the menu', () => {
  const phone = { width: 360, height: 640 };
  const box = placeAtPoint({ x: 340, y: 600 }, { width: 300, height: 300 }, phone);
  assert.ok(inside(box, { width: 300, height: 300 }, phone));
  const tiny = placeAtPoint({ x: 10, y: 10 }, { width: 500, height: 100 }, phone);
  assert.ok(tiny.left >= 8, 'a menu wider than the screen is clamped');
});

test('a dropdown sits under its button, aligned to its left edge', () => {
  const box = placeBelow({ left: 100, right: 180, top: 50, bottom: 90 }, size, viewport);
  assert.deepEqual([box.left, box.top, box.above], [100, 96, false]);
});

test('a dropdown near the right edge is pulled back inside (the clipped New menu)', () => {
  const anchor = { left: 920, right: 990, top: 50, bottom: 90 };
  const start = placeBelow(anchor, size, viewport);
  assert.equal(start.left, 1000 - 8 - 220);
  const end = placeBelow(anchor, size, viewport, { align: 'end' });
  assert.equal(end.left, 990 - 220);
});

test('a dropdown near the bottom opens upward, or scrolls when neither side has room', () => {
  const up = placeBelow({ left: 100, right: 180, top: 640, bottom: 680 }, size, viewport);
  assert.equal(up.above, true);
  assert.equal(up.top, 640 - 6 - 260);
  const short = { width: 800, height: 300 };
  const scroll = placeBelow({ left: 0, right: 80, top: 140, bottom: 180 }, { width: 220, height: 800 }, short);
  assert.ok(scroll.maxHeight > 0 && scroll.maxHeight < 800);
});
