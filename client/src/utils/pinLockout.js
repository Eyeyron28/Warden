/**
 * Local attempt limiting for the phone's PIN screen. The state is kept with the
 * device record in IndexedDB, so reloading the page or closing the browser does
 * not reset it. This slows a person holding the phone; it cannot stop someone
 * who copies the phone's storage and guesses elsewhere - that is what the PIN
 * rules and the slow key derivation are for.
 */
export const MAX_PIN_FAILURES = 10;

// Wait after the Nth wrong PIN in a row (seconds). Free tries first, then it grows.
const WAIT_SECONDS = { 3: 5, 4: 15, 5: 30, 6: 60, 7: 120, 8: 300, 9: 900 };

export const waitSecondsAfter = (failures) => (failures >= MAX_PIN_FAILURES ? Infinity : WAIT_SECONDS[failures] || 0);

/**
 * @param {{ failures?: number, notBefore?: number, lockedOut?: boolean } | undefined} state
 * @param {number} [now]
 * @returns {{ lockedOut: boolean, waitMs: number, failures: number, triesLeft: number }}
 */
export function readLockout(state, now = Date.now()) {
  const failures = Math.max(0, Number(state?.failures) || 0);
  const lockedOut = Boolean(state?.lockedOut) || failures >= MAX_PIN_FAILURES;
  const waitMs = lockedOut ? 0 : Math.max(0, (Number(state?.notBefore) || 0) - now);
  return { lockedOut, waitMs, failures, triesLeft: Math.max(0, MAX_PIN_FAILURES - failures) };
}

/** The state after one more wrong PIN. */
export function afterWrongPin(state, now = Date.now()) {
  const failures = Math.max(0, Number(state?.failures) || 0) + 1;
  if (failures >= MAX_PIN_FAILURES) return { failures, notBefore: 0, lockedOut: true };
  return { failures, notBefore: now + waitSecondsAfter(failures) * 1000, lockedOut: false };
}

/** The state after a correct PIN. */
export const afterRightPin = () => ({ failures: 0, notBefore: 0, lockedOut: false });

export function describeWait(waitMs) {
  const seconds = Math.ceil(waitMs / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
