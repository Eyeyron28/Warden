/**
 * Splits a name into the part that may be cut (shown with an ellipsis) and the part that always stays visible: the extension and
 * a few characters before it, so "Passport scan 2026 (final)....pdf" still ends in ".pdf". Works on whole characters, so an emoji
 * or a Chinese character is never cut in half.
 */
export function splitForEllipsis(name, keep = 6) {
  const chars = [...String(name ?? '')];
  const dot = chars.lastIndexOf('.');
  const tailLength = dot > 0 && chars.length - dot <= 12 ? chars.length - Math.max(0, dot - keep) : Math.min(chars.length, keep + 2);
  const cut = Math.max(0, chars.length - tailLength);
  return { head: chars.slice(0, cut).join(''), tail: chars.slice(cut).join('') };
}

/**
 * A file name for an accessible name or a tooltip: at most `max` characters (40), cut in the MIDDLE so the ending stays ("report-final...v3.pdf").
 * Only used where the full name is already on screen, so nothing is lost.
 */
export function shortName(name, max = 40) {
  const chars = [...String(name ?? '')];
  if (chars.length <= max) return chars.join('');
  const tail = Math.min(14, Math.floor((max - 1) / 2));
  const head = max - 1 - tail;
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`;
}
