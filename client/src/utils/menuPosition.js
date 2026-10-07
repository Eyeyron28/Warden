/**
 * Where a menu or popover goes so it never leaves the viewport. Pure maths on
 * rectangles, so it can be tested without a browser. All coordinates are in
 * viewport (fixed-position) pixels.
 */

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * A context menu opened at the pointer: it opens down and to the right of the
 * point, flips to the left / above when that would run off the edge, and is
 * finally clamped inside the viewport (and given a max height, so a very tall
 * menu scrolls instead of overflowing).
 *
 * @param {{ x: number, y: number }} point
 * @param {{ width: number, height: number }} size the menu's natural size
 * @param {{ width: number, height: number }} viewport
 * @returns {{ left: number, top: number, maxHeight: number, flippedX: boolean, flippedY: boolean }}
 */
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

/**
 * A dropdown under a button: below it by default, above it when there is
 * clearly more room there, aligned to the button's left or right edge, and
 * clamped horizontally so it can never run off either side.
 *
 * @param {{ left: number, right: number, top: number, bottom: number }} anchor
 * @param {{ width: number, height: number }} size
 * @param {{ width: number, height: number }} viewport
 * @param {{ align?: 'start' | 'end', gap?: number, margin?: number }} [options]
 */
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
