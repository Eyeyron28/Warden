import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ImportCardView } from './ImportCardView.jsx';
import { importJob, useImportJob } from '../services/importJob.js';
import { createDismissTimer, describeCard, importCardConfig } from '../utils/importCard.js';

/**
 * The card at the bottom right that follows an import from page to page (mounted once, above the router: main.jsx). While the job
 * runs it shows the file, "12 of 48 files", a bar and Cancel; clicking its body opens the Import screen. When it is over it shows the
 * result, a click opens the imported folder (or the report), and it goes away on its own after importCardConfig.dismissMs unless it
 * has keyboard focus. Screen readers hear a short announcement at the start, every 25% and at the end - not every file.
 */
function ImportCard() {
  const state = useImportJob();
  const navigate = useNavigate();
  const view = describeCard(state);
  const [confirming, setConfirming] = useState(false);
  const [focused, setFocused] = useState(false);
  const timer = useRef(null);
  const shown = Boolean(view);

  // The page leaves room at its bottom while the card is up, so it never hides a footer.
  useEffect(() => {
    if (!shown) return undefined;
    document.documentElement.classList.add('import-card-open');
    return () => document.documentElement.classList.remove('import-card-open');
  }, [shown]);

  const autoDismiss = Boolean(view?.autoDismiss);
  useEffect(() => {
    if (!autoDismiss) return undefined;
    const dismiss = createDismissTimer({ ms: importCardConfig.dismissMs, onExpire: () => importJob.dismissCard() });
    timer.current = dismiss;
    dismiss.start();
    return () => {
      dismiss.cancel();
      timer.current = null;
    };
  }, [autoDismiss, state.id, state.finishedAt]);

  const kind = view?.kind;
  useEffect(() => {
    if (kind !== 'running') setConfirming(false);
  }, [kind]);

  if (!view) return null;
  return (
    <ImportCardView
      view={view}
      announce={state.announce}
      focused={focused}
      confirming={confirming}
      dismissMs={importCardConfig.dismissMs}
      onOpen={() => {
        navigate(view.target);
        // A finished card has done its job once it was clicked.
        if (view.autoDismiss) importJob.dismissCard();
      }}
      onClose={() => importJob.dismissCard()}
      onAskCancel={() => setConfirming(true)}
      onStop={() => importJob.cancel()}
      onKeepGoing={() => setConfirming(false)}
      onFocus={() => {
        setFocused(true);
        timer.current?.pause();
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setFocused(false);
        timer.current?.resume();
      }}
    />
  );
}

export default ImportCard;
