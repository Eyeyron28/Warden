import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  applyItemClick,
  emptySelection,
  headerState,
  pruneSelection,
  selectAll as selectEvery,
  selectOnly as selectJust,
  toggleItem,
} from './selection.js';

const isEditable = (element) =>
  element instanceof HTMLElement &&
  (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) &&
  !(element.tagName === 'INPUT' && element.type === 'checkbox');

// Esc / Ctrl+A belong to an open dialog, menu or viewer first.
const dialogOpen = () => document.querySelector('[aria-modal="true"]') !== null;

/**
 * Selection state for one file view. `orderedKeys` is every selectable item
 * in display order (it drives ranges and select-all, and anything that leaves
 * the list is dropped from the selection). Also wires Esc (clear) and
 * Ctrl/Cmd+A (select all) for as long as the view is mounted.
 */
export function useSelection(orderedKeys) {
  const [state, setState] = useState(emptySelection);
  const signature = orderedKeys.join('\u0000');
  const keysRef = useRef(orderedKeys);
  keysRef.current = orderedKeys;

  useEffect(() => {
    setState((current) => pruneSelection(current, keysRef.current));
  }, [signature]);

  const click = useCallback((key, { shift = false } = {}) => {
    setState((current) => applyItemClick(current, keysRef.current, key, { shift }));
  }, []);
  const toggle = useCallback((key) => setState((current) => toggleItem(current, key)), []);
  const selectAll = useCallback(() => setState(selectEvery(keysRef.current)), []);
  const clear = useCallback(() => setState(emptySelection()), []);
  const setOnly = useCallback((key) => setState(selectJust(key)), []);

  const count = state.selected.size;
  const countRef = useRef(count);
  countRef.current = count;

  useEffect(() => {
    const onKeyDown = (event) => {
      if (dialogOpen()) return;
      if (event.key === 'Escape' && countRef.current > 0) {
        setState(emptySelection());
      } else if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'a') {
        if (isEditable(document.activeElement) || keysRef.current.length === 0) return;
        event.preventDefault();
        setState(selectEvery(keysRef.current));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return useMemo(
    () => ({
      selected: state.selected,
      count,
      isSelected: (key) => state.selected.has(key),
      header: headerState(count, orderedKeys.length),
      click,
      toggle,
      selectAll,
      clear,
      setOnly,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, signature, click, toggle, selectAll, clear, setOnly]
  );
}
