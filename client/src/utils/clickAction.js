/**
 * What a click on a file or folder does. Kept as one pure function so the
 * rule "a click NEVER downloads" is a testable fact rather than a habit:
 * the answer is only ever 'open-folder', 'open-preview', 'toggle' or 'range'.
 * Downloading exists only behind explicit Download buttons and menu items.
 *
 * @param {{ kind: 'file' | 'folder' | 'trash-file' | 'trash-folder' }} item
 * @param {{ onCheckbox?: boolean, shift?: boolean, ctrl?: boolean, meta?: boolean }} [event]
 * @returns {'open-folder' | 'open-preview' | 'toggle' | 'range'}
 */
export function rowClickAction(item, { onCheckbox = false, shift = false, ctrl = false, meta = false } = {}) {
  if (onCheckbox) return shift ? 'range' : 'toggle';
  if (shift) return 'range';
  if (ctrl || meta) return 'toggle';
  if (item.kind === 'folder') return 'open-folder';
  if (item.kind === 'file') return 'open-preview';
  // Items in Trash can't be opened (restore them first), so a click selects.
  return 'toggle';
}
