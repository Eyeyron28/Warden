export function rowClickAction(item, { onCheckbox = false, shift = false, ctrl = false, meta = false } = {}) {
  if (onCheckbox) return shift ? 'range' : 'toggle';
  if (shift) return 'range';
  if (ctrl || meta) return 'toggle';
  if (item.kind === 'folder') return 'open-folder';
  if (item.kind === 'file') return 'open-preview';
  return 'toggle';
}
