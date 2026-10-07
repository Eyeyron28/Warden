/**
 * Selection logic for the file views, kept free of React so it can be tested.
 * Items are identified by a string key ("file:<id>", "folder:<path>", ...).
 * A state is `{ selected: Set<string>, anchor: string | null }`; every
 * function returns a NEW state and never mutates the one it was given.
 */

export const emptySelection = () => ({ selected: new Set(), anchor: null });

export function toggleItem(state, key) {
  const selected = new Set(state.selected);
  if (selected.has(key)) selected.delete(key);
  else selected.add(key);
  return { selected, anchor: key };
}

/** Adds every item between the anchor and `key` (inclusive). Without a usable anchor it just selects `key`. */
export function selectRange(state, orderedKeys, key) {
  const to = orderedKeys.indexOf(key);
  if (to === -1) return state;
  const from = state.anchor === null ? -1 : orderedKeys.indexOf(state.anchor);
  if (from === -1) {
    const selected = new Set(state.selected);
    selected.add(key);
    return { selected, anchor: key };
  }
  const [start, end] = from <= to ? [from, to] : [to, from];
  const selected = new Set(state.selected);
  for (let i = start; i <= end; i += 1) selected.add(orderedKeys[i]);
  return { selected, anchor: key };
}

export function selectAll(orderedKeys) {
  return { selected: new Set(orderedKeys), anchor: orderedKeys.length ? orderedKeys[orderedKeys.length - 1] : null };
}

/** Drops anything that is no longer in the list (deleted, moved, filtered out). */
export function pruneSelection(state, orderedKeys) {
  const valid = new Set(orderedKeys);
  const selected = new Set([...state.selected].filter((key) => valid.has(key)));
  if (selected.size === state.selected.size) return state;
  return { selected, anchor: state.anchor !== null && valid.has(state.anchor) ? state.anchor : null };
}

/**
 * A click ON a checkbox, or a modified click on a row: Shift extends a
 * range, Ctrl/Cmd toggles one item, a plain checkbox click toggles too.
 */
export function applyItemClick(state, orderedKeys, key, { shift = false } = {}) {
  return shift ? selectRange(state, orderedKeys, key) : toggleItem(state, key);
}

/** State of the "select all" checkbox: 'none' | 'some' (indeterminate) | 'all'. */
export function headerState(selectedCount, total) {
  if (selectedCount === 0 || total === 0) return 'none';
  return selectedCount >= total ? 'all' : 'some';
}
