import { invalidateAll } from './dataCache.js';
import { invalidateThumbnail } from './thumbnailCache.js';
import { uploadDocument, uploadNewVersion } from './documentsService.js';
import { DOCUMENTS_CHANGED } from '../utils/dragMove.js';
import { quarantineCount } from './quarantineCount.js';
import { limitCodeOf, limitedError, retrySeconds } from '../utils/uploadLimits.js';

// Quarantine: a refused upload (nothing saved) is worded for the tray; a held one moves the sidebar badge.
// An upload limit: "Not saved" with the sentence (utils/uploadLimits.js); the manager marks the rest of the batch the same way.
const refusal = (error) => {
  const limit = limitCodeOf(error);
  if (limit) {
    error.described = limitedError(limit, retrySeconds(error), error.response.data.error.message);
    return error;
  }
  const code = error?.response?.data?.error?.code;
  if (code !== 'FILE_BLOCKED' && code !== 'VERSION_REFUSED' && code !== 'USE_IMPORT') return error; // (USE_IMPORT: a zip by its bytes)
  const reasons = error.response.data.error.reasons;
  error.described = { message: 'Not saved', code: 'refused', retryable: false, refused: true, reasons: Array.isArray(reasons) ? reasons : [], version: code === 'VERSION_REFUSED' };
  return error;
};
const watched = (send) => async (...args) => {
  try {
    const data = await send(...args);
    if (data?.held) {
      // the reasons, for the tray row
      data.held = data.reasons || []; // { code, text }: the server's plain sentences, for the tooltip
      quarantineCount.bump(1);
    }
    return data;
  } catch (error) {
    throw refusal(error);
  }
};

/**
 * What the transfers manager does with the world (services/transfers.js): the real uploads, and what follows a finished batch. Kept
 * apart so that loading the app does not load the upload code; it arrives with the first transfer.
 */
export const runtime = {
  uploadDocument: watched(uploadDocument),
  uploadNewVersion: watched(uploadNewVersion),
  // Once per batch (not once per file): every cached list is out of date, and whatever page shows files, folder counts, the
  // sidebar tree or the storage meter reads them again.
  onFinished: ({ replacedIds = [] } = {}) => {
    invalidateAll();
    // A replaced file's preview was drawn from its old contents.
    for (const id of replacedIds) if (id) invalidateThumbnail(id);
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(DOCUMENTS_CHANGED, { detail: {} }));
  },
};
