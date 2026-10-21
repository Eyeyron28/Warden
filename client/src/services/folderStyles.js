import { useSyncExternalStore } from 'react';

import { subscribeToken } from './session.js';

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

export const useFolderStyles = () => useSyncExternalStore(subscribe, getFolderStyles, getFolderStyles);

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

subscribeToken(() => {
  setFolderStyles({});
  quarantineCount.set(0);
});
