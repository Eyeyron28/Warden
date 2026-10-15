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

// One session never sees another's folders.
subscribeToken(() => setFolderStyles({}));
