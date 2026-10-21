export const hasFiles = (event) => Array.from(event?.dataTransfer?.types || []).includes('Files');

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
