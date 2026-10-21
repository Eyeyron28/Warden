import { invalidateAll } from './dataCache.js';
import { invalidateThumbnail } from './thumbnailCache.js';
import { uploadDocument, uploadNewVersion } from './documentsService.js';
import { DOCUMENTS_CHANGED } from '../utils/dragMove.js';
import { quarantineCount } from './quarantineCount.js';
import { limitCodeOf, limitedError, retrySeconds } from '../utils/uploadLimits.js';

const refusal = (error) => {
  const limit = limitCodeOf(error);
  if (limit) {
    error.described = limitedError(limit, retrySeconds(error), error.response.data.error.message);
    return error;
  }
  const code = error?.response?.data?.error?.code;
  if (code !== 'FILE_BLOCKED' && code !== 'VERSION_REFUSED' && code !== 'USE_IMPORT') return error;
  const reasons = error.response.data.error.reasons;
  error.described = { message: 'Not saved', code: 'refused', retryable: false, refused: true, reasons: Array.isArray(reasons) ? reasons : [], version: code === 'VERSION_REFUSED' };
  return error;
};
const watched = (send) => async (...args) => {
  try {
    const data = await send(...args);
    if (data?.held) {
      data.held = data.reasons || [];
      quarantineCount.bump(1);
    }
    return data;
  } catch (error) {
    throw refusal(error);
  }
};

export const runtime = {
  uploadDocument: watched(uploadDocument),
  uploadNewVersion: watched(uploadNewVersion),
  onFinished: ({ replacedIds = [] } = {}) => {
    invalidateAll();
    for (const id of replacedIds) if (id) invalidateThumbnail(id);
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(DOCUMENTS_CHANGED, { detail: {} }));
  },
};
