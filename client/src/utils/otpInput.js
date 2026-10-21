export const CODE_LENGTH = 6;

export const emptyDigits = () => Array.from({ length: CODE_LENGTH }, () => '');

export function digitsOnly(text) {
  return String(text ?? '').replace(/[^0-9]/g, '');
}

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

export function formatClock(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}
