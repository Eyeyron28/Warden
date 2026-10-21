const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function placeAtPoint(point, size, viewport, margin = 8) {
  const maxHeight = Math.max(0, viewport.height - margin * 2);
  const width = Math.min(size.width, Math.max(0, viewport.width - margin * 2));
  const height = Math.min(size.height, maxHeight);

  let left = point.x;
  const flippedX = left + width > viewport.width - margin;
  if (flippedX) left = point.x - width;
  left = clamp(left, margin, Math.max(margin, viewport.width - margin - width));

  let top = point.y;
  const flippedY = top + height > viewport.height - margin;
  if (flippedY) top = point.y - height;
  top = clamp(top, margin, Math.max(margin, viewport.height - margin - height));

  return { left, top, maxHeight, flippedX, flippedY };
}

export function placeBelow(anchor, size, viewport, { align = 'start', gap = 6, margin = 8 } = {}) {
  const width = Math.min(size.width, Math.max(0, viewport.width - margin * 2));
  const roomBelow = viewport.height - anchor.bottom - gap - margin;
  const roomAbove = anchor.top - gap - margin;
  const above = size.height > roomBelow && roomAbove > roomBelow;
  const room = Math.max(0, above ? roomAbove : roomBelow);
  const height = Math.min(size.height, room);

  let left = align === 'end' ? anchor.right - width : anchor.left;
  left = clamp(left, margin, Math.max(margin, viewport.width - margin - width));
  const top = above ? anchor.top - gap - height : anchor.bottom + gap;

  return { left, top, maxHeight: room, above };
}
