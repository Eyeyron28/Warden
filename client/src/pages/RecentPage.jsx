import { useCallback, useEffect, useState } from 'react';
import { Clock } from '@phosphor-icons/react';

import DriveList from '../components/DriveList.jsx';
import { useDetailsPanel } from '../components/useDetailsPanel.jsx';
import { listRecent, starDocuments } from '../services/documentsService.js';
import { extractErrorMessage } from '../services/api.js';
import { formatManila } from '../utils/activityText.js';
import { DOCUMENTS_CHANGED } from '../utils/dragMove.js';
import { usePageMeta } from '../utils/usePageMeta.js';
import styles from './FilePages.module.css';

const WHAT = {
  upload: 'Uploaded',
  view: 'Opened',
  download: 'Downloaded',
  rename: 'Renamed',
  move: 'Moved',
  restore: 'Restored',
  expiry_set: 'Expiry date set',
  expiry_cleared: 'Expiry date removed',
};

/**
 * Recent: the last 30 files you uploaded, opened or changed, newest first, with the device that last opened each. It is read
 * from the activity log (nothing extra is stored), so it only reaches back as far as that log does.
 */
function RecentPage() {
  usePageMeta('Recent', 'The files you opened, uploaded or changed lately.');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setData(await listRecent());
      setError('');
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not load your recent files.'));
    }
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(DOCUMENTS_CHANGED, refresh);
    return () => window.removeEventListener(DOCUMENTS_CHANGED, refresh);
  }, [refresh]);

  const items = data?.items ?? [];
  const days = data?.retentionDays ?? 30;

  const mark = (id, value) => setData((prev) => (prev ? { ...prev, items: prev.items.map((doc) => (doc.id === id ? { ...doc, starred: value } : doc)) } : prev));
  const setStar = async (id, value) => {
    mark(id, value);
    try {
      await starDocuments([id], value);
    } catch (err) {
      mark(id, !value);
      setError(extractErrorMessage(err, 'Could not change the star.'));
    }
  };

  const details = useDetailsPanel({
    isStarred: (id) => Boolean(items.find((doc) => doc.id === id)?.starred),
    toggleStar: (id) => setStar(id, !items.find((doc) => doc.id === id)?.starred),
  });

  const note = (doc) => {
    const opened = doc.openedOnDevice
      ? `Opened on ${doc.openedOnDevice}${doc.openedOnThisDevice ? ' (this browser)' : ''}${doc.lastOpenedAt ? `, ${formatManila(doc.lastOpenedAt)}` : ''}`
      : 'Not opened lately';
    return `${WHAT[doc.lastActivity.type] || 'Changed'} ${formatManila(doc.lastActivity.at)} · ${opened}`;
  };

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div className={styles.titleBlock}>
          <h1 className={styles.heading}>Recent</h1>
          <span className={styles.count}>{!data && !error ? 'Loading…' : `${items.length} file${items.length === 1 ? '' : 's'}`}</span>
        </div>
      </div>
      {error && (
        <p className={styles.banner} role="alert">
          {error}
        </p>
      )}
      {data && items.length === 0 && !error && (
        <div className={styles.empty}>
          <Clock size={22} weight="light" className={styles.emptyIcon} />
          <span>
            Nothing here yet. Recent shows what you uploaded, opened or changed in the last {days} days: that is how long the activity
            log it comes from is kept. Files in Trash are left out.
          </span>
        </div>
      )}
      {items.length > 0 && (
        <DriveList
          items={items}
          label="Recent files"
          note={note}
          onToggleStar={(doc) => setStar(doc.id, !doc.starred)}
          onShowDetails={(doc, opener) => details.show(doc.id, doc.filename, opener)}
        />
      )}
      {items.length > 0 && <p className={styles.retention}>Recent reaches back {days} days, as far as the activity log is kept.</p>}
      {details.element}
    </div>
  );
}

export default RecentPage;
