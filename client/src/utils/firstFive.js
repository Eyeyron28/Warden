export const CARD_ROWS = 5;

export function firstFive(items, limit = CARD_ROWS) {
  const list = Array.isArray(items) ? items : [];
  return { shown: list.slice(0, limit), more: list.length > limit, total: list.length };
}
