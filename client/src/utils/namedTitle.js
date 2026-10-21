export function splitNamedTitle(title) {
  const match = /^([^"]*")(.+)("[^"]*)$/s.exec(String(title ?? ''));
  return match ? { before: match[1], name: match[2], after: match[3] } : null;
}
