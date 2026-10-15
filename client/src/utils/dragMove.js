import { batchMoveDocuments } from '../services/documentsService.js';
import { DRAG_MIME } from './dragAndDrop.js';

/** Fired on `window` after files were moved by a drop outside the file page (the sidebar), so pages showing files can refresh. */
export const DOCUMENTS_CHANGED = 'warden:documents-changed';

/** Whether a drag carries Warden files (and not, say, a file from the desktop). */
export const dragCarriesDocuments = (event) => Array.from(event.dataTransfer?.types || []).includes(DRAG_MIME);

/** The ids in a Warden drag: one id, or several separated by commas. */
export function idsFromDrag(event) {
  return String(event.dataTransfer?.getData(DRAG_MIME) || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/** The text that says what a batch move did (or why it did not). */
export function describeMove(response) {
  if (response.movedCount > 0) {
    return { message: `Moved ${response.movedCount} item${response.movedCount === 1 ? '' : 's'} to ${response.destination || 'My files'}` };
  }
  const reason = response.results.find((entry) => entry.status !== 'unchanged' && entry.message)?.message;
  return reason ? { error: reason } : { message: 'Already in that folder' };
}

/** Moves dropped files to a folder (up to 50 per request, a result for each) and tells the pages. */
export async function moveDroppedDocuments(ids, destination) {
  const response = await batchMoveDocuments(ids, destination);
  window.dispatchEvent(new CustomEvent(DOCUMENTS_CHANGED, { detail: describeMove(response) }));
  return response;
}
