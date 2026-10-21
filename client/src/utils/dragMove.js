import { batchMoveDocuments } from '../services/documentsService.js';
import { DRAG_MIME } from './dragAndDrop.js';

export const DOCUMENTS_CHANGED = 'warden:documents-changed';

export const dragCarriesDocuments = (event) => Array.from(event.dataTransfer?.types || []).includes(DRAG_MIME);

export function idsFromDrag(event) {
  return String(event.dataTransfer?.getData(DRAG_MIME) || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

export function describeMove(response) {
  if (response.movedCount > 0) {
    return { message: `Moved ${response.movedCount} item${response.movedCount === 1 ? '' : 's'} to ${response.destination || 'My files'}` };
  }
  const reason = response.results.find((entry) => entry.status !== 'unchanged' && entry.message)?.message;
  return reason ? { error: reason } : { message: 'Already in that folder' };
}

export async function moveDroppedDocuments(ids, destination) {
  const response = await batchMoveDocuments(ids, destination);
  window.dispatchEvent(new CustomEvent(DOCUMENTS_CHANGED, { detail: describeMove(response) }));
  return response;
}
