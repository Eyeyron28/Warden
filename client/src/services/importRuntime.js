import { createFolder, uploadDocument } from './documentsService.js';
import { invalidateAll } from './dataCache.js';
import { reportClientEvent } from './securityService.js';
import { DOCUMENTS_CHANGED } from '../utils/dragMove.js';
import { inspectZip, runImport } from '../utils/zipImport.js';
import { uploadSlots } from './uploadSlots.js';

/**
 * What the import job actually does with the world: the zip code, the upload, the folder creation, and what follows a finished
 * import. Kept apart from the job's state machine (services/importJob.js) so that loading the app does not load the zip code.
 */
export const runtime = {
  runImport,
  loadJSZip: async () => (await import('jszip')).default,
  inspect: inspectZip,
  // The normal upload: the 4 MB cap, the quota, the type sniffing and - for a name already in use - the same-name counter.
  // ...through the same 2 upload slots as every other transfer, so the tray never has more than 2 files on the wire.
  uploadFile: async (file, folder) => {
    await uploadSlots.acquire();
    try {
      return await uploadDocument({ file, folder });
    } finally {
      uploadSlots.release();
    }
  },
  createFolder,
  onFinished: ({ uploaded }) => {
    // New files: every cached list is out of date, and any page showing files reads them again.
    invalidateAll();
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(DOCUMENTS_CHANGED, { detail: {} }));
    if (uploaded > 0) reportClientEvent('import');
  },
};
