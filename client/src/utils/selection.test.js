import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyItemClick, emptySelection, headerState, pruneSelection, selectAll, selectRange, toggleItem,
} from './selection.js';

const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
const set = (state) => [...state.selected].sort();

test('toggle adds and removes one item and moves the anchor', () => {
  let state = toggleItem(emptySelection(), 'b');
  assert.deepEqual(set(state), ['b']);
  assert.equal(state.anchor, 'b');
  state = toggleItem(state, 'd');
  assert.deepEqual(set(state), ['b', 'd']);
  state = toggleItem(state, 'b');
  assert.deepEqual(set(state), ['d']);
});

test('it never mutates the state it was given', () => {
  const before = toggleItem(emptySelection(), 'a');
  const frozen = new Set(before.selected);
  toggleItem(before, 'b');
  selectRange(before, keys, 'e');
  pruneSelection(before, ['z']);
  assert.deepEqual([...before.selected], [...frozen]);
});

test('shift-click selects the range from the anchor, in either direction', () => {
  let state = toggleItem(emptySelection(), 'b');
  state = applyItemClick(state, keys, 'e', { shift: true });
  assert.deepEqual(set(state), ['b', 'c', 'd', 'e']);
  state = applyItemClick(toggleItem(emptySelection(), 'e'), keys, 'b', { shift: true });
  assert.deepEqual(set(state), ['b', 'c', 'd', 'e']);
});

test('a range keeps what was already selected, and without an anchor selects just that item', () => {
  let state = toggleItem(toggleItem(emptySelection(), 'a'), 'f');
  state = selectRange({ ...state, anchor: 'c' }, keys, 'd');
  assert.deepEqual(set(state), ['a', 'c', 'd', 'f']);
  assert.deepEqual(set(selectRange(emptySelection(), keys, 'c')), ['c']);
  assert.deepEqual(set(selectRange(toggleItem(emptySelection(), 'gone'), keys, 'c')), ['c', 'gone']);
  assert.equal(selectRange(emptySelection(), keys, 'unknown').selected.size, 0);
});

test('ctrl/cmd and plain checkbox clicks toggle', () => {
  const state = applyItemClick(toggleItem(emptySelection(), 'a'), keys, 'c', { shift: false });
  assert.deepEqual(set(state), ['a', 'c']);
});

test('select all, and the header checkbox states', () => {
  assert.deepEqual(set(selectAll(keys)), keys);
  assert.equal(headerState(0, 6), 'none');
  assert.equal(headerState(3, 6), 'some');
  assert.equal(headerState(6, 6), 'all');
  assert.equal(headerState(0, 0), 'none');
  assert.equal(headerState(1, 0), 'none');
});

test('items that disappear are dropped from the selection', () => {
  const state = selectAll(keys);
  const pruned = pruneSelection(state, ['a', 'b', 'x']);
  assert.deepEqual(set(pruned), ['a', 'b']);
  assert.equal(pruned.anchor, null, 'the anchor went with its item');
  assert.equal(pruneSelection(state, keys), state, 'nothing to drop: same object');
});
