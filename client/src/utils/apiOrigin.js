/**
 * Where the phone-side flows (pairing, sync, phone recovery) may send
 * requests: this page's OWN origin, and nothing else.
 *
 * These flows carry the master password (pairing) and the device token
 * (everything after), so the destination can never come from anywhere an
 * attacker can influence - not the URL, query string or hash (a crafted
 * pairing link), and not storage (a value saved by an earlier hostile link).
 * It used to: PairPage read `?apiBase=` and posted the master password to
 * whatever it said.
 *
 * Same origin is enough. In development the Vite server proxies /api to the
 * backend (vite.config.js), and when deployed the API is served from the same
 * origin as the app - and a paired device's IndexedDB is per-origin anyway,
 * so the origin that paired is always the origin that syncs.
 */

/**
 * The only API base the phone flows use: the origin of the page they're
 * running on. Takes the page's URL and deliberately looks at nothing in it
 * except the origin - never the path, query or hash.
 *
 * @param {string} [pageHref]
 * @returns {string} e.g. "https://192.168.1.50:5173"
 */
export function sameOriginApiBase(pageHref = window.location.href) {
  return new URL(pageHref).origin;
}

/**
 * Defense in depth for the request helpers: throws unless `apiBase` is
 * exactly this page's origin, so a stray caller passing some other value (a
 * stored record, a parameter) fails loudly instead of sending credentials
 * elsewhere. Rejects other hosts, other ports, other schemes, scheme-relative
 * `//host`, `user@host` tricks like `https://good.example@evil.example`, and
 * anything carrying a path.
 *
 * @param {string} apiBase
 * @param {string} [pageOrigin]
 * @returns {string} apiBase, unchanged, when it is the page's own origin
 */
export function assertSameOrigin(apiBase, pageOrigin = window.location.origin) {
  let parsed;
  try {
    parsed = new URL(apiBase);
  } catch {
    throw new Error('Refusing to send credentials: the server address is not a valid origin.');
  }
  if (parsed.origin !== pageOrigin || apiBase.replace(/\/+$/, '') !== pageOrigin) {
    throw new Error('Refusing to send credentials to a server other than the one this page came from.');
  }
  return apiBase;
}
