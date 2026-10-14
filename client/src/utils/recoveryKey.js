/**
 * Display and export helpers for the recovery key. Pure functions on a string already in memory: nothing here reads or
 * writes any browser storage. The key's own format (four groups of four, dashed) is decided by the server and is not
 * changed or checked here beyond splitting it on its dashes.
 */

export const COPY_FEEDBACK_MS = 2000;

/** The groups to draw as chips: "X5N7-8DYX-9ERG-XMR3" -> ['X5N7', '8DYX', '9ERG', 'XMR3']. No dashes in any of them. */
export function keyGroups(key) {
  return String(key ?? '')
    .split('-')
    .filter(Boolean);
}

/** The key as it is copied: its normal dashed form, on ONE line, nothing else. */
export function keyForCopy(key) {
  return keyGroups(key).join('-');
}

/** What a screen reader says for the whole key, as one labelled string (each group read on its own). */
export function keySpoken(key) {
  const groups = keyGroups(key).map((group) => group.split('').join(' '));
  return `Recovery key: ${groups.join(', ')}`;
}

/** The text of the .txt download. */
export function keyDownloadText({ key, email, date = new Date() }) {
  const day = date.toISOString().slice(0, 10);
  return [
    'Warden recovery key',
    '',
    keyForCopy(key),
    '',
    email ? `Email: ${email}` : '',
    `Date: ${day}`,
    '',
    'Keep this private. Warden cannot show it again.',
  ]
    .filter((line, index, lines) => line || lines[index - 1])
    .join('\n');
}

/** The page of the key sheet that is printed (kept as data so it can be tested; the component renders it). */
export function keySheet({ key, email, date = new Date() }) {
  return {
    title: 'Warden recovery key',
    key: keyForCopy(key),
    email: email || '',
    date: date.toISOString().slice(0, 10),
    note: 'Keep this private. Warden cannot show it again.',
  };
}

/** Number of columns the chips use: four on a desktop or tablet, two (a 2x2 block) on a phone. */
export function keyColumns(viewportWidth) {
  return Number(viewportWidth) <= 560 ? 2 : 4;
}
