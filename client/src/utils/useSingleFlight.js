import { useMemo } from 'react';

/**
 * Lets an action run once at a time. `run(fn)` starts `fn` only if the previous one has finished; a second call in the meantime
 * (a double click, Enter pressed twice, two taps) does nothing and returns undefined. The flag is a ref set SYNCHRONOUSLY, before
 * any await and before React has re-rendered, so it holds even when two events arrive in the same tick - which a disabled
 * button alone does not guarantee.
 */
export function useSingleFlight() {
  return useMemo(() => createSingleFlight(), []);
}

/** The same guard without React (what the hook holds), so it can be tested on its own. */
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
