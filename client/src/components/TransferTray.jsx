import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { TransferTrayView } from './TransferTrayView.jsx';
import { importJob, useImportJob } from '../services/importJob.js';
import { transfers, useTransfers } from '../services/transfers.js';
import { createDismissTimer, importCardConfig } from '../utils/importCard.js';
import { buildTray } from '../utils/trayModel.js';

/**
 * The tray at the bottom right: one card for every transfer in the app (uploads, new versions, the zip import as its last row). It
 * opens with the first transfer, never takes focus, minimizes with Escape, and closes by itself 45 s after everything is sealed
 * with nothing failed (paused while the pointer or keyboard focus is on it). A failure keeps it open until dismissed.
 */
function TransferTray() {
  const t = useTransfers();
  const job = useImportJob();
  const navigate = useNavigate();
  const model = useMemo(() => buildTray(t, job), [t, job]);
  const [minimized, setMinimized] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [paused, setPaused] = useState(false);
  const timer = useRef(null);
  const shown = model.visible;

  // The page leaves room at its bottom while the tray is up, so it never hides a footer.
  useEffect(() => {
    if (!shown) return undefined;
    document.documentElement.classList.add('import-card-open');
    return () => document.documentElement.classList.remove('import-card-open');
  }, [shown]);

  const dismissAll = () => {
    transfers.dismissFinished();
    importJob.dismissCard();
  };

  const autoDismiss = model.autoDismiss;
  const finishedKey = `${t.rows.map((row) => `${row.id}:${row.finishedAt}`).join(',')}|${job.id}:${job.finishedAt}`;
  useEffect(() => {
    if (!autoDismiss) return undefined;
    const dismiss = createDismissTimer({ ms: importCardConfig.dismissMs, onExpire: dismissAll });
    timer.current = dismiss;
    dismiss.start();
    return () => {
      dismiss.cancel();
      timer.current = null;
    };
  }, [autoDismiss, finishedKey]);

  useEffect(() => {
    if (!model.running) setConfirmClose(false);
  }, [model.running]);

  if (!shown) return null;

  const pause = () => {
    setPaused(true);
    timer.current?.pause();
  };
  const resume = () => {
    setPaused(false);
    timer.current?.resume();
  };

  const onAction = (row, action) => {
    if (action === 'review') {
      navigate(row.actions.review);
      return;
    }
    if (action === 'show') {
      navigate(row.actions.show);
      return;
    }
    if (row.source === 'import') {
      if (action === 'cancel') importJob.cancel();
      else if (action === 'dismiss') importJob.dismissCard();
      return;
    }
    if (action === 'cancel') transfers.cancel(row.transferId);
    else if (action === 'retry') transfers.retry(row.transferId);
    else if (action === 'dismiss') transfers.dismiss(row.transferId);
  };

  return (
    <TransferTrayView
      model={model}
      announce={[t.announce, job.announce].filter(Boolean).join(' ')}
      minimized={minimized}
      confirmClose={confirmClose}
      paused={paused}
      dismissMs={importCardConfig.dismissMs}
      onToggleMinimize={() => setMinimized((value) => !value)}
      onClose={() => (model.running ? setConfirmClose(true) : dismissAll())}
      onStop={() => {
        transfers.cancelAll();
        importJob.cancel();
        setConfirmClose(false);
      }}
      onKeepGoing={() => setConfirmClose(false)}
      onAction={onAction}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !minimized) {
          event.stopPropagation();
          setMinimized(true);
        }
      }}
      onFocus={pause}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) resume();
      }}
      onMouseEnter={pause}
      onMouseLeave={resume}
    />
  );
}

export default TransferTray;
