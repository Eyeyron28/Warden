/**
 * Open-redirect guard. Use it on ANY navigation target that did not come
 * from a string literal in the code: a "return to" / "next" value, router
 * state, a query parameter, anything read from storage.
 *
 * Why this exists: React Router 6 (the version Warden uses) has an open
 * redirect via a backslash in <Link>/<Navigate>/useNavigate - `/\evil.com`
 * is treated as a relative path by the router, but a browser reads `\` as
 * `/`, so it navigates to `//evil.com`, i.e. another site. The fix upstream
 * needs the v7 major upgrade; until then every dynamic target goes through
 * here instead.
 *
 * A target is accepted only if it is a same-origin PATH:
 *   - a string, at most 2048 characters;
 *   - starts with exactly one "/" (not "//", not "/\", so not
 *     protocol-relative), and so has no scheme (`https:`, `javascript:`,
 *     `data:`);
 *   - no backslash, and no whitespace or control characters anywhere - the
 *     URL parser silently strips tabs and newlines, so `/<TAB>/evil.com`
 *     would otherwise become `//evil.com`;
 *   - the same holds after percent-decoding, repeatedly, so `%2F%2Fevil.com`,
 *     `/%5Cevil.com` and double-encoded forms can't smuggle any of the
 *     above past the check. Malformed encoding (`%zz`, a lone `%`) is
 *     rejected rather than guessed at;
 *   - and, as a last line of defense, it must still resolve to this site's
 *     own origin when run through the platform URL parser.
 *
 * Anything else returns `fallback` (default "/"). The original string is
 * returned unchanged when it passes - never a decoded or rewritten one.
 *
 * @param {unknown} target
 * @param {string} [fallback='/']
 * @returns {string}
 */
export function safeRedirectPath(target, fallback = '/') {
  return isSafeRedirectPath(target) ? target : fallback;
}

const MAX_LENGTH = 2048;
const MAX_DECODE_PASSES = 4;
// Whitespace and control characters: NUL through space, DEL and the C1
// controls, and the Unicode line/paragraph separators. Tab, CR and LF matter
// most - the URL parser silently strips them, so `/<TAB>/evil.com` would
// otherwise be read as `//evil.com`. Checked by character code rather than
// with a regex literal so the source stays plain ASCII.
// A plain space is rejected as written but allowed once decoded, so a normal
// path like `/files/my%20file.pdf` still passes while a literal space (or an
// encoded tab, CR, LF or NUL) does not.
function isForbiddenChar(char, allowSpace) {
  const code = char.charCodeAt(0);
  if (code === 0x20) return !allowSpace;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}
const PLACEHOLDER_ORIGIN = 'https://warden.invalid';

function isSafeForm(value, allowSpace) {
  if (value.length === 0 || value[0] !== '/') return false;
  // "//host" (protocol-relative) and "/\host" (read as "//host" by browsers).
  if (value[1] === '/' || value[1] === '\\') return false;
  if (value.includes('\\')) return false;
  for (const char of value) {
    if (isForbiddenChar(char, allowSpace)) return false;
  }
  return true;
}

export function isSafeRedirectPath(target) {
  if (typeof target !== 'string' || target.length === 0 || target.length > MAX_LENGTH) return false;

  // Check the string as written, then every percent-decoded form of it.
  let current = target;
  for (let pass = 0; pass <= MAX_DECODE_PASSES; pass += 1) {
    // Pass 0 is the string exactly as written; later passes are decoded forms.
    if (!isSafeForm(current, pass > 0)) return false;
    let decoded;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return false; // malformed % sequence
    }
    if (decoded === current) break;
    current = decoded;
    // Still changing after the last allowed pass: too deeply encoded to trust.
    if (pass === MAX_DECODE_PASSES) return false;
  }

  try {
    return new URL(target, PLACEHOLDER_ORIGIN).origin === PLACEHOLDER_ORIGIN;
  } catch {
    return false;
  }
}
