import { invalidateAll } from './dataCache.js';
import { invalidateThumbnail } from './thumbnailCache.js';
import { uploadDocument, uploadNewVersion } from './documentsService.js';
import { DOCUMENTS_CHANGED } from '../utils/dragMove.js';

/**
 * What the transfers manager does with the world (services/transfers.js): the real uploads, and what follows a finished batch. Kept
 * apart so that loading the app does not load the upload code; it arrives with the first transfer.
 */
export const runtime = {
  uploadDocument,
  uploadNewVersion,
  // Once per batch (not once per file): every cached list is out of date, and whatever page shows files, folder counts, the
  // sidebar tree or the storage meter reads them again.
  onFinished: ({ replacedIds = [] } = {}) => {
    invalidateAll();
    // A replaced file's preview was drawn from its old contents.
    for (const id of replacedIds) if (id) invalidateThumbnail(id);
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(DOCUMENTS_CHANGED, { detail: {} }));
  },
};
