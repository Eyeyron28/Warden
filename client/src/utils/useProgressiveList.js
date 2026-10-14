import { useEffect, useState } from 'react';

/**
 * Draws a long list in steps instead of all at once.
 *
 * Measured on My files with 400 files in the top folder at 4x CPU slowdown: the network was finished about 2 seconds in and
 * the list still took until about 7.5 seconds to appear, because React built every row (each with its menu, icon and
 * handlers) in ONE go on the main thread. The first screenful now appears at once and the rest is added in batches while the
 * browser is idle. The DATA is never cut: search, "Select all" and sorting still work on every file; only how many rows are
 * in the page at a given moment changes, and after a moment all of them are.
 */
export const FIRST_ROWS = 40;
export const ROWS_PER_STEP = 120;

/** How many rows to show after one more step. Pure, so it can be tested. */
export function nextRenderCount(current, total, step = ROWS_PER_STEP) {
  return Math.min(total, Math.max(current, 0) + step);
}

const later = (callback) => {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(callback, { timeout: 300 });
    return () => window.cancelIdleCallback(id);
  }
  const id = setTimeout(callback, 16);
  return () => clearTimeout(id);
};

export function useProgressiveList(items) {
  const [count, setCount] = useState(FIRST_ROWS);
  const total = items.length;

  useEffect(() => {
    if (count >= total) return undefined;
    return later(() => setCount((current) => nextRenderCount(current, total)));
  }, [count, total]);

  return total > count ? items.slice(0, count) : items;
}
