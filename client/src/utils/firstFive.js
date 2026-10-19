// The Overview cards show at most five rows; above five a "View all" button opens the whole list.
export const CARD_ROWS = 5;

/** @returns {{ shown: any[], more: boolean, total: number }} */
export function firstFive(items, limit = CARD_ROWS) {
  const list = Array.isArray(items) ? items : [];
  return { shown: list.slice(0, limit), more: list.length > limit, total: list.length };
}
