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

export const kitGroups = (kit) => String(kit || '').split('-').filter(Boolean);

export function kitRows(kit, perRow = 4) {
  const groups = kitGroups(kit);
  const rows = [];
  for (let i = 0; i < groups.length; i += perRow) rows.push(groups.slice(i, i + perRow));
  return rows;
}

const KIT_CHARS = 52;

export function normalizeKitInput(text) {
  const clean = String(text ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '').slice(0, KIT_CHARS);
  return clean.match(/.{1,4}/g)?.join('-') ?? '';
}

export const isCompleteKit = (text) => String(text ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '').length === KIT_CHARS;
