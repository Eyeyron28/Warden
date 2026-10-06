/**
 * Drag-and-drop of a document row/card onto a folder tile - desktop only.
 * The payload is the document's id under a Warden-specific MIME type, so a
 * drop target can tell a Warden document drag apart from, say, a file
 * dragged in from the OS (which it ignores).
 *
 * Only enabled where the primary pointer is a mouse/trackpad: touch
 * browsers don't fire HTML5 drag events reliably, and a long-press there
 * already means something else.
 */
export const DRAG_MIME = 'application/x-warden-document';

export function canDragDocuments() {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches;
}
