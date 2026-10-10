/**
 * Where an Emergency Kit lives in the browser: in a variable inside one component, and nowhere else.
 *
 * The kit code (and the QR drawn from it) is shown ONCE, right after setup or after replacing the kit. It must
 * never reach localStorage, sessionStorage, IndexedDB, a cookie, the address bar, history, the console or any
 * request. This holder is the only place the wizard puts it, it has no persistence of any kind, and `clear()`
 * runs when the screen is left (and on unmount).
 */

export function createKitHolder() {
  let kit = null;
  return {
    set(value) {
      kit = typeof value === 'string' && value ? value : null;
    },
    get: () => kit,
    has: () => kit !== null,
    clear() {
      kit = null;
    },
  };
}

/** "ABCD-EFGH-..." -> ['ABCD','EFGH',...] */
export const kitGroups = (kit) => String(kit || '').split('-').filter(Boolean);

/** The groups laid out in rows (default four to a row) for the large monospace display. */
export function kitRows(kit, perRow = 4) {
  const groups = kitGroups(kit);
  const rows = [];
  for (let i = 0; i < groups.length; i += perRow) rows.push(groups.slice(i, i + perRow));
  return rows;
}

const KIT_CHARS = 52; // 32 bytes in base32

/** What a person typed or pasted -> the kit as the server expects it: upper case, groups of four with dashes. */
export function normalizeKitInput(text) {
  const clean = String(text ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '').slice(0, KIT_CHARS);
  return clean.match(/.{1,4}/g)?.join('-') ?? '';
}

export const isCompleteKit = (text) => String(text ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '').length === KIT_CHARS;
