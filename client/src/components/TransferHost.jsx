import { Suspense, lazy } from 'react';

import { useImportJob } from '../services/importJob.js';
import { useTransfers } from '../services/transfers.js';

const TransferHostUi = lazy(() => import('./TransferHostUi.jsx'));

function TransferHost() {
  const t = useTransfers();
  const job = useImportJob();
  const idle = t.rows.length === 0 && job.status === 'idle' && !t.signOutPrompt && !job.signOutPrompt;
  if (idle) return null;
  return (
    <Suspense fallback={null}>
      <TransferHostUi />
    </Suspense>
  );
}

export default TransferHost;
