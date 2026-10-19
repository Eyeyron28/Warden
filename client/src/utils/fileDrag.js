// Drag and drop of files from the computer: whether a drag carries files, and a counter that tells when it has really left.

/** True when the drag carries files from the computer (not text, and not Warden's own in-app drags). */
export const hasFiles = (event) => Array.from(event?.dataTransfer?.types || []).includes('Files');

/**
 * Counts dragenter and dragleave pairs. Moving over a child fires a leave on the parent and an enter on the child, so a
 * plain "left" flag flickers or sticks; a counter is on while it is above zero. reset() is for every other way a drag ends.
 */
export function createDragCounter() {
  let depth = 0;
  return {
    enter() {
      depth += 1;
      return depth > 0;
    },
    leave() {
      depth = Math.max(0, depth - 1);
      return depth > 0;
    },
    reset() {
      depth = 0;
      return false;
    },
    get active() {
      return depth > 0;
    },
  };
}
