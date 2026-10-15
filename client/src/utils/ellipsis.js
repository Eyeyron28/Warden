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
