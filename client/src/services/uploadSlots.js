export const MAX_PARALLEL_UPLOADS = 2;

const abortError = () => Object.assign(new Error('Canceled'), { name: 'AbortError', aborted: true });

export function createSlots(max = MAX_PARALLEL_UPLOADS) {
  let free = max;
  const queue = [];
  return {
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(abortError());
      if (free > 0) {
        free -= 1;
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, signal, onAbort: null };
        waiter.onAbort = () => {
          const at = queue.indexOf(waiter);
          if (at >= 0) queue.splice(at, 1);
          reject(abortError());
        };
        signal?.addEventListener('abort', waiter.onAbort, { once: true });
        queue.push(waiter);
      });
    },
    release() {
      const next = queue.shift();
      if (next) {
        next.signal?.removeEventListener('abort', next.onAbort);
        next.resolve();
      } else {
        free = Math.min(max, free + 1);
      }
    },
    stats: () => ({ free, waiting: queue.length, max }),
  };
}

export const uploadSlots = createSlots();
