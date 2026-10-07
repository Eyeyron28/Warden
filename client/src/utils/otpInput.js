/**
 * Pure helpers behind the six-box login code input (components/OtpCodeInput).
 * The state is an array of exactly six strings, each '' or one ASCII digit.
 * Everything here returns a NEW array and the box that should take focus.
 */

export const CODE_LENGTH = 6;

export const emptyDigits = () => Array.from({ length: CODE_LENGTH }, () => '');

/** Keeps ASCII digits only (so letters, spaces, dashes and full-width digits are dropped). */
export function digitsOnly(text) {
  return String(text ?? '').replace(/[^0-9]/g, '');
}

/**
 * Types or pastes `text` into box `index`, spilling into the following boxes.
 * A code pasted whole (six or more digits) always starts from the first box,
 * wherever the cursor was.
 * @returns {{ digits: string[], focusIndex: number }}
 */
export function fillFrom(digits, index, text) {
  const typed = digitsOnly(text);
  if (!typed) return { digits, focusIndex: index };
  const start = typed.length >= CODE_LENGTH ? 0 : index;
  const next = [...digits];
  let position = start;
  for (const char of typed) {
    if (position >= CODE_LENGTH) break;
    next[position] = char;
    position += 1;
  }
  return { digits: next, focusIndex: Math.min(position, CODE_LENGTH - 1) };
}

/** Backspace: clears this box, or if it is already empty, the previous one. */
export function backspaceAt(digits, index) {
  const next = [...digits];
  if (next[index]) {
    next[index] = '';
    return { digits: next, focusIndex: index };
  }
  if (index === 0) return { digits, focusIndex: 0 };
  next[index - 1] = '';
  return { digits: next, focusIndex: index - 1 };
}

export const isComplete = (digits) => digits.every((d) => d !== '');
export const toCode = (digits) => digits.join('');

/** m:ss for a number of seconds. */
export function formatClock(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}
