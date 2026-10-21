export const COPY_FEEDBACK_MS = 2000;

export function keyGroups(key) {
  return String(key ?? '')
    .split('-')
    .filter(Boolean);
}

export function keyForCopy(key) {
  return keyGroups(key).join('-');
}

export function keySpoken(key) {
  const groups = keyGroups(key).map((group) => group.split('').join(' '));
  return `Recovery key: ${groups.join(', ')}`;
}

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

export function keySheet({ key, email, date = new Date() }) {
  return {
    title: 'Warden recovery key',
    key: keyForCopy(key),
    email: email || '',
    date: date.toISOString().slice(0, 10),
    note: 'Keep this private. Warden cannot show it again.',
  };
}

export function keyColumns(viewportWidth) {
  return Number(viewportWidth) <= 560 ? 2 : 4;
}
