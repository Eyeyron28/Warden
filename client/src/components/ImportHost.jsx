import { Suspense, lazy } from 'react';

import { useImportJob } from '../services/importJob.js';

// The card and the sign-out question are loaded the first time a job exists, so they are not part of the main bundle.
const ImportHostUi = lazy(() => import('./ImportHostUi.jsx'));

/**
 * Mounted once, beside the routes and inside the router (main.jsx): no page change can remove it. It renders nothing - and loads
 * nothing - until an import job exists.
 */
function ImportHost() {
  const job = useImportJob();
  if (job.status === 'idle' && !job.signOutPrompt) return null;
  return (
    <Suspense fallback={null}>
      <ImportHostUi />
    </Suspense>
  );
}

export default ImportHost;
