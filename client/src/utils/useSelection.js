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

const dialogOpen = () => document.querySelector('[aria-modal="true"]') !== null;

export function useSelection(orderedKeys, allKeys = orderedKeys) {
  const [state, setState] = useState(emptySelection);
  const signature = orderedKeys.join('\u0000');
  const keysRef = useRef(orderedKeys);
  keysRef.current = orderedKeys;
  const allRef = useRef(allKeys);
  allRef.current = allKeys;
  const allSignature = allKeys.join('\u0000');

  useEffect(() => {
    setState((current) => pruneSelection(current, keysRef.current));
  }, [signature]);

  const click = useCallback((key, { shift = false } = {}) => {
    setState((current) => applyItemClick(current, keysRef.current, key, { shift }));
  }, []);
  const toggle = useCallback((key) => setState((current) => toggleItem(current, key)), []);
  const selectAll = useCallback(() => setState(selectEvery(allRef.current)), []);
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
        if (isEditable(document.activeElement) || allRef.current.length === 0) return;
        event.preventDefault();
        setState(selectEvery(allRef.current));
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
      header: headerState(allKeys.filter((key) => state.selected.has(key)).length, allKeys.length),
      click,
      toggle,
      selectAll,
      clear,
      setOnly,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, signature, allSignature, click, toggle, selectAll, clear, setOnly]
  );
}
