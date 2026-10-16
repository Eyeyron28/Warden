import { useSyncExternalStore } from 'react';

import { subscribeToken } from './session.js';

// The look (colour and icon) of every folder that has one, by path. It arrives with the top-level folder answer that every page
// already asks for (GET /documents/folders/children), so breadcrumbs and folder tiles are drawn without another request.
let styles = {};
const listeners = new Set();

export const getFolderStyles = () => styles;

export function setFolderStyles(next) {
  styles = next && typeof next === 'object' ? next : {};
  listeners.forEach((listener) => listener());
}

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The map { path: { color, icon } }, re-rendering when it changes. */
export const useFolderStyles = () => useSyncExternalStore(subscribe, getFolderStyles, getFolderStyles);

// How many files are held in Quarantine (the sidebar badge). It rides on the same top-level answer, and moves with what this tab does
// (a held upload, a release, a delete), so it costs no request of its own. In memory only.
let held = 0;
export const quarantineCount = {
  set(next) {
    const value = Math.max(0, next | 0);
    if (value === held) return;
    held = value;
    listeners.forEach((listener) => listener());
  },
  bump(by = 1) {
    this.set(held + by);
  },
};
const getHeld = () => held;
export const useQuarantineCount = () => useSyncExternalStore(subscribe, getHeld, getHeld);

// One session never sees another's folders (or held files).
subscribeToken(() => {
  setFolderStyles({});
  quarantineCount.set(0);
});
