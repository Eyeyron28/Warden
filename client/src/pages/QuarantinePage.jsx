import { useCallback, useEffect, useState } from 'react';

import QuarantineList, { HONEST_LINE } from '../components/QuarantineList.jsx';
import ReleaseDialog from '../components/ReleaseDialog.jsx';
import { useShell } from '../components/ShellContext.js';
import { deleteDocument } from '../services/documentsService.js';
import { extractErrorMessage } from '../services/api.js';
import { invalidateAll } from '../services/dataCache.js';
import { quarantineCount } from '../services/quarantineCount.js';
import { listHeld, releaseHeld } from '../services/quarantineService.js';
import { usePageMeta } from '../utils/usePageMeta.js';
import styles from './QuarantinePage.module.css';

const isSessionExpired = (err) => err?.response?.status === 401;

function QuarantinePage() {
  usePageMeta('Quarantine', 'Files that looked risky, held until you decide.');
  const { showToast, refreshSidebar } = useShell();
  const [state, setState] = useState('loading');
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [releasing, setReleasing] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const data = await listHeld();
      setItems(data.items);
      setState('list');
    } catch (err) {
      if (isSessionExpired(err)) return;
      setError(extractErrorMessage(err, 'Could not load the held files.'));
      setState('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (item) => {
    setBusyId(item.id);
    try {
      await deleteDocument(item.id);
      invalidateAll();
      setItems((current) => current.filter((row) => row.id !== item.id));
      quarantineCount.bump(-1);
      refreshSidebar();
      showToast('Moved to Trash.');
    } catch (err) {
      if (!isSessionExpired(err)) showToast(extractErrorMessage(err, 'Could not delete that file.'));
    } finally {
      setBusyId(null);
    }
  };

  const confirmRelease = async (word) => {
    const { item } = releasing;
    setReleasing({ item, busy: true, error: '' });
    try {
      await releaseHeld(item.id, word);
      setItems((current) => current.filter((row) => row.id !== item.id));
      setReleasing(null);
      refreshSidebar();
      showToast('Released. It is now in My files.');
    } catch (err) {
      if (isSessionExpired(err)) return;
      setReleasing({ item, busy: false, error: extractErrorMessage(err, 'Could not release that file.') });
    }
  };

  const view = state === 'list' && items.length === 0 ? 'empty' : state;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Quarantine</h1>
        <p className={styles.lead}>{HONEST_LINE}</p>
      </header>
      <QuarantineList state={view} items={items} error={error} busyId={busyId} onRetry={load} onDelete={remove} onRelease={(item) => setReleasing({ item, busy: false, error: '' })} />
      {releasing && <ReleaseDialog item={releasing.item} busy={releasing.busy} error={releasing.error} onCancel={() => setReleasing(null)} onConfirm={confirmRelease} />}
    </div>
  );
}

export default QuarantinePage;
