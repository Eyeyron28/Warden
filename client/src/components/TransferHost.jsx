import { Suspense, lazy } from 'react';

import { useImportJob } from '../services/importJob.js';
import { useTransfers } from '../services/transfers.js';

// The tray and the sign-out question load the first time a transfer or an import exists, so they are not in the main bundle.
const TransferHostUi = lazy(() => import('./TransferHostUi.jsx'));

/**
 * Mounted once, beside the routes and inside the router (main.jsx): no page change can remove it. It renders nothing - and loads
 * nothing - until a transfer or an import exists.
 */
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
