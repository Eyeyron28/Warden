import { useCallback, useEffect, useMemo, useState } from 'react';
import { Star } from '@phosphor-icons/react';

import DriveList from '../components/DriveList.jsx';
import { useDetailsPanel } from '../components/useDetailsPanel.jsx';
import { listDocuments, peekDocuments, starDocuments } from '../services/documentsService.js';
import { extractErrorMessage } from '../services/api.js';
import { DOCUMENTS_CHANGED } from '../utils/dragMove.js';
import { usePageMeta } from '../utils/usePageMeta.js';
import styles from './FilePages.module.css';

/**
 * Starred: the files the owner starred, from the list My files already loads (the stars come with it, so this page asks for
 * nothing new). Files in Trash are not in that list, so they are never here.
 */
function StarredPage() {
  usePageMeta('Starred', 'The files you starred.');
  const [documents, setDocuments] = useState(() => peekDocuments() ?? []);
  const [loading, setLoading] = useState(() => peekDocuments() === undefined);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setDocuments(await listDocuments());
      setError('');
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not load your starred files.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(DOCUMENTS_CHANGED, refresh);
    return () => window.removeEventListener(DOCUMENTS_CHANGED, refresh);
  }, [refresh]);

  const starred = useMemo(() => documents.filter((doc) => doc.starred).sort((a, b) => a.filename.localeCompare(b.filename)), [documents]);

  const setStar = async (id, value) => {
    // At once; put back if the server says no.
    setDocuments((prev) => prev.map((doc) => (doc.id === id ? { ...doc, starred: value } : doc)));
    try {
      await starDocuments([id], value);
    } catch (err) {
      setDocuments((prev) => prev.map((doc) => (doc.id === id ? { ...doc, starred: !value } : doc)));
      setError(extractErrorMessage(err, 'Could not change the star.'));
    }
  };

  const details = useDetailsPanel({
    isStarred: (id) => Boolean(documents.find((doc) => doc.id === id)?.starred),
    toggleStar: (id) => setStar(id, !documents.find((doc) => doc.id === id)?.starred),
  });

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div className={styles.titleBlock}>
          <h1 className={styles.heading}>Starred</h1>
          <span className={styles.count}>{loading ? 'Loading…' : `${starred.length} file${starred.length === 1 ? '' : 's'}`}</span>
        </div>
      </div>
      {error && (
        <p className={styles.banner} role="alert">
          {error}
        </p>
      )}
      {!loading && starred.length === 0 && !error && (
        <div className={styles.empty}>
          <Star size={22} weight="light" className={styles.emptyIcon} />
          <span>No starred files yet. Star a file in My files to find it here.</span>
        </div>
      )}
      {starred.length > 0 && (
        <DriveList
          items={starred}
          label="Starred files"
          onToggleStar={(doc) => setStar(doc.id, !doc.starred)}
          onShowDetails={(doc, opener) => details.show(doc.id, doc.filename, opener)}
        />
      )}
      {details.element}
    </div>
  );
}

export default StarredPage;
