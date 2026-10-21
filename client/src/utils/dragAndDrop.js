export const DRAG_MIME = 'application/x-warden-document';

export function canDragDocuments() {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches;
}
