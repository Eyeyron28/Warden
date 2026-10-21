import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import Banner from '../components/Banner.jsx';
import ExpiryModal from '../components/ExpiryModal.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import { useShell } from '../components/ShellContext.js';
import { deleteDocument, downloadBytes, fetchDocumentBytes, listExpiringDocuments } from '../services/documentsService.js';
import { extractErrorMessage } from '../services/api.js';
import { formatDate } from '../utils/formatDate.js';
import { formatExpiryDay } from '../utils/expiry.js';
import { selectExpired } from '../utils/expiredDocs.js';
import { formatBytes } from '../utils/listing.js';
import { usePageMeta } from '../utils/usePageMeta.js';
import styles from './ExpiredPage.module.css';

const isSessionExpired = (err) => err?.response?.status === 401;
const folderLabel = (folder) => (!folder || folder === 'root' ? 'My files' : folder);
const openLink = (doc) => `/files?path=${encodeURIComponent(doc.folder && doc.folder !== 'root' ? doc.folder : '')}&open=${encodeURIComponent(doc.id)}`;

function ExpiredPage() {
  usePageMeta('Expired documents', 'Documents that passed their expiry date.');
  const { showToast } = useShell();
  const [docs, setDocs] = useState(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [expiryDocument, setExpiryDocument] = useState(null);

  useEffect(() => {
    let cancelled = false;
    listExpiringDocuments()
      .then((list) => !cancelled && setDocs(Array.isArray(list) ? list : []))
      .catch((err) => !cancelled && !isSessionExpired(err) && setError(extractErrorMessage(err, 'Could not load your documents.')));
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => selectExpired(docs || []), [docs]);

  const download = async (doc) => {
    setActionError('');
    setBusyId(doc.id);
    try {
      const { bytes, filename } = await fetchDocumentBytes(doc.id, { purpose: 'download' });
      downloadBytes(bytes, filename);
    } catch (err) {
      if (!isSessionExpired(err)) setActionError(extractErrorMessage(err, 'Download failed.'));
    } finally {
      setBusyId('');
    }
  };

  const trash = async (doc) => {
    setActionError('');
    setBusyId(doc.id);
    try {
      await deleteDocument(doc.id);
      setDocs((current) => current.filter((entry) => entry.id !== doc.id));
      showToast(`Moved "${doc.filename}" to Trash`);
    } catch (err) {
      if (!isSessionExpired(err)) setActionError(extractErrorMessage(err, 'Could not move this file to Trash.'));
    } finally {
      setBusyId('');
    }
  };

  const expirySaved = (updated) => {
    setDocs((current) =>
      current.map((doc) =>
        doc.id === updated.id ? { ...doc, expiryDate: updated.expiryDate, docExpiresAt: updated.docExpiresAt, daysUntilExpiry: updated.daysUntilExpiry, expiryStatus: updated.expiryStatus ?? 'ok' } : doc
      )
    );
    showToast(updated.docExpiresAt ? 'Expiry date saved' : 'Expiry date removed');
  };

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Expired documents</h1>
      <p className={styles.lede}>Documents that passed their expiry date.</p>

      {actionError && (
        <Banner as="p" className={styles.banner} role="alert" onDismiss={() => setActionError('')}>
          {actionError}
        </Banner>
      )}
      {error && (
        <Banner as="p" className={styles.banner} role="alert" onDismiss={() => setError('')}>
          {error}
        </Banner>
      )}

      {docs === null && !error && <p className={styles.empty}>Loading…</p>}

      {docs !== null && rows.length === 0 && (
        <div className={styles.emptyBox}>
          <p className={styles.empty}>No expired documents.</p>
          <Link to="/files" className={styles.back}>
            Back to My files
          </Link>
        </div>
      )}

      {rows.length > 0 && (
        <ol className={styles.list} aria-label="Expired documents">
          {rows.map((doc) => (
            <li key={doc.id} className={styles.row} data-testid="expired-row">
              <div className={styles.info}>
                <Link to={openLink(doc)} className={styles.name} title={doc.filename}>
                  {doc.filename}
                </Link>
                <span className={styles.meta}>
                  {folderLabel(doc.folder)} · {formatBytes(doc.size)} · {formatDate(doc.createdAt)}
                </span>
                <span className={styles.expiry}>
                  <StatusBadge label="Expired" tone="danger" />
                  <span className={styles.meta}>{formatExpiryDay(doc.docExpiresAt || doc.expiryDate)}</span>
                </span>
              </div>
              <div className={styles.actions}>
                <button type="button" className={styles.action} onClick={() => download(doc)} disabled={busyId === doc.id}>
                  Download
                </button>
                <button type="button" className={styles.action} onClick={() => setExpiryDocument(doc)} disabled={busyId === doc.id}>
                  Change expiry date…
                </button>
                <button type="button" className={`${styles.action} ${styles.danger}`} onClick={() => trash(doc)} disabled={busyId === doc.id}>
                  Move to trash
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}

      {expiryDocument && <ExpiryModal document={expiryDocument} onClose={() => setExpiryDocument(null)} onSaved={expirySaved} />}
    </div>
  );
}

export default ExpiredPage;
