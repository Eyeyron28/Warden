/**
 * A dialog title such as  Share "passport.pdf"  or  Rename "Taxes": the part in quotes is a file or folder name, which can be 255
 * characters long and must be cut in the middle instead of widening the dialog. Returns { before, name, after } (the quotes stay in
 * `before` and `after`), or null when the title has no quoted name. The name is everything from the first quote to the LAST one,
 * so a name that itself contains a quote is kept whole.
 */
export function splitNamedTitle(title) {
  const match = /^([^"]*")(.+)("[^"]*)$/s.exec(String(title ?? ''));
  return match ? { before: match[1], name: match[2], after: match[3] } : null;
}
