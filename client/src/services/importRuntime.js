import { createFolder, uploadDocument } from './documentsService.js';
import { invalidateAll } from './dataCache.js';
import { reportClientEvent } from './securityService.js';
import { DOCUMENTS_CHANGED } from '../utils/dragMove.js';
import { inspectZip, runImport } from '../utils/zipImport.js';
import { outcomeOf, outcomeText } from '../utils/importCard.js';
import { uploadSlots } from './uploadSlots.js';
import { quarantineCount } from './quarantineCount.js';

export const runtime = {
  runImport,
  outcomeLine: (state) => outcomeText(outcomeOf(state)),
  stoppedLine: (state, why) => {
    const { imported, held, refused, other } = outcomeOf({ skipped: [], ignored: [], ...state });
    const bits = [`${imported} ${imported === 1 ? 'file was' : 'files were'} imported`, held ? `${held} held for review` : '', refused ? `${refused} not saved` : '', other ? `${other} not imported` : ''].filter(Boolean);
    return `Stopped: ${why.replace(/[.\s]+$/, '')}. ${bits.join(', ')}.`;
  },
  loadJSZip: async () => (await import('jszip')).default,
  inspect: inspectZip,
  uploadFile: async (file, folder) => {
    await uploadSlots.acquire();
    try {
      const stored = await uploadDocument({ file, folder });
      if (stored?.held) quarantineCount.bump(1);
      return stored;
    } finally {
      uploadSlots.release();
    }
  },
  createFolder,
  onFinished: ({ uploaded }) => {
    invalidateAll();
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(DOCUMENTS_CHANGED, { detail: {} }));
    if (uploaded > 0) reportClientEvent('import');
  },
};
