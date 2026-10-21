import { useEffect, useState } from 'react';

export const FIRST_ROWS = 40;
export const ROWS_PER_STEP = 120;

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
