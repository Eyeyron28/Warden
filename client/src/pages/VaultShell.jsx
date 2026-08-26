import { useCallback, useEffect, useState } from 'react';
import { ClockCounterClockwise, FolderLock, HardDrive, Plus } from '@phosphor-icons/react';

import Header from '../components/Header.jsx';
import DocumentRow from '../components/DocumentRow.jsx';
import UploadForm from '../components/UploadForm.jsx';
import BackupPanel from '../components/BackupPanel.jsx';
import RestorePanel from '../components/RestorePanel.jsx';
import ShareModal from '../components/ShareModal.jsx';
import {
  listDocuments,
  uploadDocument,
  fetchDocumentBlob,
  openBlob,
  deleteDocument,
} from '../services/documentsService.js';
import { getBackupStatus, exportBackup, importBackup } from '../services/backupService.js';
import { extractErrorMessage } from '../services/api.js';
import { formatDateTime } from '../utils/formatDate.js';
import { sortByExpiryUrgency } from '../utils/documentSort.js';
import styles from './VaultShell.module.css';

// A 401 mid-request means the session just expired - the axios interceptor
// already clears it, and App's route guard is about to unmount this whole
// page, so there's no point flashing an error banner for it.
const isSessionExpired = (err) => err?.response?.status === 401;

function VaultShell({ onLocked }) {
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState('');

  const [viewingId, setViewingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [actionError, setActionError] = useState('');

  const [sharingDocument, setSharingDocument] = useState(null);

  const [backupStatus, setBackupStatus] = useState(null);
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupSubmitting, setBackupSubmitting] = useState(false);
  const [backupError, setBackupError] = useState('');
  const [backupResult, setBackupResult] = useState(null);

  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreSubmitting, setRestoreSubmitting] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [restoreResult, setRestoreResult] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setListError('');
    try {
      const data = await listDocuments();
      setDocuments(sortByExpiryUrgency(data));
    } catch (err) {
      if (!isSessionExpired(err)) {
        setListError(extractErrorMessage(err, 'Could not load your documents.'));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshBackupStatus = useCallback(async () => {
    try {
      const data = await getBackupStatus();
      setBackupStatus(data);
    } catch {
      // Status is informational, not critical path - a failed fetch here
      // just means the "last backup" line stays blank rather than
      // blocking the vault view with an error banner.
    }
  }, []);

  useEffect(() => {
    refresh();
    refreshBackupStatus();
  }, [refresh, refreshBackupStatus]);

  const handleUpload = async ({ file, folder, expiryDate }) => {
    setUploading(true);
    setUploadProgress(0);
    setUploadError('');
    try {
      await uploadDocument({ file, folder, expiryDate }, setUploadProgress);
      setUploadOpen(false);
      await refresh();
    } catch (err) {
      setUploadError(extractErrorMessage(err, 'Upload failed.'));
    } finally {
      setUploading(false);
    }
  };

  const handleView = async (id) => {
    setActionError('');
    setViewingId(id);
    try {
      const { blob, filename } = await fetchDocumentBlob(id);
      openBlob(blob, filename);
    } catch (err) {
      if (!isSessionExpired(err)) {
        setActionError(extractErrorMessage(err, 'Could not open this document.'));
      }
    } finally {
      setViewingId(null);
    }
  };

  const handleDelete = async (id) => {
    setActionError('');
    setDeletingId(id);
    try {
      await deleteDocument(id);
      setDocuments((prev) => prev.filter((doc) => doc.id !== id));
    } catch (err) {
      if (!isSessionExpired(err)) {
        setActionError(extractErrorMessage(err, 'Could not delete this document.'));
      }
    } finally {
      setDeletingId(null);
    }
  };

  const openUploadPanel = () => {
    setBackupOpen(false);
    setRestoreOpen(false);
    setUploadOpen((open) => !open);
  };

  const openBackupPanel = () => {
    setUploadOpen(false);
    setRestoreOpen(false);
    setBackupOpen((open) => !open);
  };

  const openRestorePanel = () => {
    setUploadOpen(false);
    setBackupOpen(false);
    setRestoreOpen((open) => !open);
  };

  const closeBackupPanel = () => {
    setBackupOpen(false);
    setBackupError('');
    setBackupResult(null);
  };

  const closeRestorePanel = () => {
    setRestoreOpen(false);
    setRestoreError('');
    setRestoreResult(null);
  };

  const handleBackupExport = async (targetPath) => {
    setBackupSubmitting(true);
    setBackupError('');
    try {
      const result = await exportBackup(targetPath);
      setBackupResult(result);
      setBackupStatus({
        lastBackupAt: result.timestamp,
        documentCount: result.documentsBackedUp,
        backupPath: result.backupPath,
      });
    } catch (err) {
      setBackupError(extractErrorMessage(err, 'Backup failed.'));
    } finally {
      setBackupSubmitting(false);
    }
  };

  const handleRestoreImport = async (sourcePath) => {
    setRestoreSubmitting(true);
    setRestoreError('');
    try {
      const result = await importBackup(sourcePath);
      setRestoreResult(result);
      await refresh();
    } catch (err) {
      setRestoreError(extractErrorMessage(err, 'Restore failed.'));
    } finally {
      setRestoreSubmitting(false);
    }
  };

  const backupStatusLine = backupStatus?.lastBackupAt
    ? `Last backup: ${formatDateTime(backupStatus.lastBackupAt)} · ${backupStatus.documentCount} document${backupStatus.documentCount === 1 ? '' : 's'}`
    : backupStatus
      ? 'No backup yet'
      : '';

  return (
    <div className={styles.shell}>
      <Header onLock={onLocked} />

      <main className={styles.content}>
        <div className={styles.contentInner}>
          <div className={styles.toolbar}>
            <div>
              <h1 className={styles.heading}>Your documents</h1>
              <p className={styles.count}>
                {loading
                  ? 'Loading...'
                  : `${documents.length} document${documents.length === 1 ? '' : 's'}`}
              </p>
            </div>
            <div className={styles.toolbarActions}>
              <button type="button" className={styles.secondaryActionButton} onClick={openRestorePanel}>
                <ClockCounterClockwise size={16} weight="bold" />
                <span>Restore from backup</span>
              </button>
              <button type="button" className={styles.secondaryActionButton} onClick={openBackupPanel}>
                <HardDrive size={16} weight="bold" />
                <span>Back up to USB</span>
              </button>
              <button type="button" className={styles.addButton} onClick={openUploadPanel}>
                <Plus size={16} weight="bold" />
                <span>Add document</span>
              </button>
            </div>
          </div>

          {backupStatusLine && <p className={styles.backupStatusLine}>{backupStatusLine}</p>}

          {uploadOpen && (
            <UploadForm
              onSubmit={handleUpload}
              onCancel={() => {
                setUploadOpen(false);
                setUploadError('');
              }}
              uploading={uploading}
              progress={uploadProgress}
              error={uploadError}
            />
          )}

          {backupOpen && (
            <BackupPanel
              onSubmit={handleBackupExport}
              onCancel={closeBackupPanel}
              submitting={backupSubmitting}
              error={backupError}
              result={backupResult}
            />
          )}

          {restoreOpen && (
            <RestorePanel
              onSubmit={handleRestoreImport}
              onCancel={closeRestorePanel}
              submitting={restoreSubmitting}
              error={restoreError}
              result={restoreResult}
            />
          )}

          {actionError && <p className={styles.banner}>{actionError}</p>}
          {listError && <p className={styles.banner}>{listError}</p>}

          {!loading && documents.length === 0 && !listError && (
            <div className={styles.emptyState}>
              <FolderLock size={40} weight="light" className={styles.emptyIcon} />
              <h2 className={styles.emptyTitle}>Your vault is empty</h2>
              <p className={styles.emptyBody}>Add your first document to get started.</p>
            </div>
          )}

          {documents.length > 0 && (
            <ul className={styles.list}>
              {documents.map((doc) => (
                <DocumentRow
                  key={doc.id}
                  document={doc}
                  onView={handleView}
                  onDelete={handleDelete}
                  onShare={setSharingDocument}
                  isViewing={viewingId === doc.id}
                  isDeleting={deletingId === doc.id}
                />
              ))}
            </ul>
          )}
        </div>
      </main>

      {sharingDocument && (
        <ShareModal
          documentId={sharingDocument.id}
          filename={sharingDocument.filename}
          onClose={() => setSharingDocument(null)}
        />
      )}
    </div>
  );
}

export default VaultShell;
