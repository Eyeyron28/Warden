import { useMemo } from 'react';

export function useSingleFlight() {
  return useMemo(() => createSingleFlight(), []);
}

export function createSingleFlight() {
  let busy = false;
  return async (fn) => {
    if (busy) return undefined;
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  };
}
