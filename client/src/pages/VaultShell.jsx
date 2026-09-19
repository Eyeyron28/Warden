import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckSquare,
  ClockCounterClockwise,
  DeviceMobile,
  FolderLock,
  HardDrive,
  Plus,
  ShareNetwork,
  ShieldCheck,
  Trash,
} from '@phosphor-icons/react';

import Header from '../components/Header.jsx';
import DocumentRow from '../components/DocumentRow.jsx';
import UploadForm from '../components/UploadForm.jsx';
import BackupPanel from '../components/BackupPanel.jsx';
import RestorePanel from '../components/RestorePanel.jsx';
import PairDevicePanel from '../components/PairDevicePanel.jsx';
import PairedDevicesPanel from '../components/PairedDevicesPanel.jsx';
import ShareModal from '../components/ShareModal.jsx';
import EditDocumentModal from '../components/EditDocumentModal.jsx';
import FolderFilter from '../components/FolderFilter.jsx';
import {
  listDocuments,
  uploadDocument,
  fetchDocumentBlob,
  openBlob,
  deleteDocument,
  listFolders,
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
  const [editingDocument, setEditingDocument] = useState(null);

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [confirmingBulkDelete, setConfirmingBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const [folders, setFolders] = useState([]);
  const [activeFolder, setActiveFolder] = useState(null); // null = "All"

  const [backupStatus, setBackupStatus] = useState(null);
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupSubmitting, setBackupSubmitting] = useState(false);
  const [backupError, setBackupError] = useState('');
  const [backupResult, setBackupResult] = useState(null);

  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreSubmitting, setRestoreSubmitting] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [restoreResult, setRestoreResult] = useState(null);

  const [pairOpen, setPairOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);

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

  const refreshFolders = useCallback(async () => {
    try {
      const data = await listFolders();
      setFolders(data);
      // If the folder currently being filtered on no longer exists (its
      // last document was moved or deleted elsewhere), fall back to "All"
      // rather than silently showing an empty list with no way out.
      setActiveFolder((current) => (current && !data.includes(current) ? null : current));
    } catch {
      // Folder list is a filtering convenience, not critical path - a
      // failed fetch just leaves the existing filter options stale.
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
    refreshFolders();
  }, [refresh, refreshBackupStatus, refreshFolders]);

  const handleUpload = async ({ file, folder, expiryDate }) => {
    setUploading(true);
    setUploadProgress(0);
    setUploadError('');
    try {
      await uploadDocument({ file, folder, expiryDate }, setUploadProgress);
      setUploadOpen(false);
      await refresh();
      refreshFolders();
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
      // Keeps the bulk-select count honest if this row's own trash icon was
      // used while that same document happened to be checked.
      setSelectedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      refreshFolders();
    } catch (err) {
      if (!isSessionExpired(err)) {
        setActionError(extractErrorMessage(err, 'Could not delete this document.'));
      }
    } finally {
      setDeletingId(null);
    }
  };

  const enterSelectMode = () => {
    setSelectMode(true);
    setSelectedIds(new Set());
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setConfirmingBulkDelete(false);
  };

  const toggleSelected = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleBulkDeleteClick = () => {
    if (selectedIds.size === 0) return;
    if (confirmingBulkDelete) {
      setConfirmingBulkDelete(false);
      handleBulkDelete();
    } else {
      setConfirmingBulkDelete(true);
    }
  };

  const handleBulkDelete = async () => {
    setActionError('');
    setBulkDeleting(true);
    const ids = Array.from(selectedIds);
    // allSettled rather than all: one failing delete shouldn't leave the
    // others un-applied just because Promise.all rejected on the first
    // failure - whichever succeeded should still disappear from the list.
    const results = await Promise.allSettled(ids.map((id) => deleteDocument(id)));
    const deletedIds = new Set(ids.filter((_, index) => results[index].status === 'fulfilled'));
    const failedCount = ids.length - deletedIds.size;

    if (deletedIds.size > 0) {
      setDocuments((prev) => prev.filter((doc) => !deletedIds.has(doc.id)));
      refreshFolders();
    }
    if (failedCount > 0) {
      setActionError(
        `Could not delete ${failedCount} of ${ids.length} selected document${ids.length === 1 ? '' : 's'}.`
      );
    }

    setBulkDeleting(false);
    exitSelectMode();
  };

  const handleBulkShare = () => {
    if (selectedIds.size !== 1) return;
    const [onlyId] = selectedIds;
    const doc = documents.find((item) => item.id === onlyId);
    if (doc) setSharingDocument(doc);
  };

  const handleEditSaved = (updatedDocument) => {
    // Splice the updated metadata straight into the already-loaded list
    // and re-sort - PATCH's response has the same shape listDocuments
    // returns, so there's no need to refetch the whole list just because
    // one document's filename/folder/expiry changed.
    setDocuments((prev) =>
      sortByExpiryUrgency(
        prev.map((doc) => (doc.id === updatedDocument.id ? updatedDocument : doc))
      )
    );
    refreshFolders();
  };

  const openUploadPanel = () => {
    setBackupOpen(false);
    setRestoreOpen(false);
    setPairOpen(false);
    setDevicesOpen(false);
    setUploadOpen((open) => !open);
  };

  const openBackupPanel = () => {
    setUploadOpen(false);
    setRestoreOpen(false);
    setPairOpen(false);
    setDevicesOpen(false);
    setBackupOpen((open) => !open);
  };

  const openRestorePanel = () => {
    setUploadOpen(false);
    setBackupOpen(false);
    setPairOpen(false);
    setDevicesOpen(false);
    setRestoreOpen((open) => !open);
  };

  const openPairPanel = () => {
    setUploadOpen(false);
    setBackupOpen(false);
    setRestoreOpen(false);
    setDevicesOpen(false);
    setPairOpen((open) => !open);
  };

  const openDevicesPanel = () => {
    setUploadOpen(false);
    setBackupOpen(false);
    setRestoreOpen(false);
    setPairOpen(false);
    setDevicesOpen((open) => !open);
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

  const folderCounts = useMemo(() => {
    const counts = { total: documents.length };
    for (const doc of documents) {
      const folder = doc.folder || 'root';
      counts[folder] = (counts[folder] || 0) + 1;
    }
    return counts;
  }, [documents]);

  // Filtering is purely client-side against the already-fetched list -
  // no per-folder backend endpoint, `folders`/`activeFolder` only ever
  // drive what's shown here.
  const visibleDocuments = useMemo(() => {
    if (activeFolder === null) return documents;
    return documents.filter((doc) => (doc.folder || 'root') === activeFolder);
  }, [documents, activeFolder]);

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
              {!selectMode && documents.length > 0 && (
                <button type="button" className={styles.secondaryActionButton} onClick={enterSelectMode}>
                  <CheckSquare size={16} weight="bold" />
                  <span>Select</span>
                </button>
              )}
              <button type="button" className={styles.secondaryActionButton} onClick={openPairPanel}>
                <DeviceMobile size={16} weight="bold" />
                <span>Pair a device</span>
              </button>
              <button type="button" className={styles.secondaryActionButton} onClick={openDevicesPanel}>
                <ShieldCheck size={16} weight="bold" />
                <span>Paired devices</span>
              </button>
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

          {pairOpen && <PairDevicePanel onClose={() => setPairOpen(false)} />}

          {devicesOpen && <PairedDevicesPanel onCancel={() => setDevicesOpen(false)} />}

          {actionError && <p className={styles.banner}>{actionError}</p>}
          {listError && <p className={styles.banner}>{listError}</p>}

          {documents.length > 0 && (
            <FolderFilter
              folders={folders}
              counts={folderCounts}
              activeFolder={activeFolder}
              onSelect={setActiveFolder}
            />
          )}

          {!loading && documents.length === 0 && !listError && (
            <div className={styles.emptyState}>
              <FolderLock size={40} weight="light" className={styles.emptyIcon} />
              <h2 className={styles.emptyTitle}>Your vault is empty</h2>
              <p className={styles.emptyBody}>Add your first document to get started.</p>
            </div>
          )}

          {documents.length > 0 && visibleDocuments.length === 0 && (
            <div className={styles.emptyState}>
              <FolderLock size={40} weight="light" className={styles.emptyIcon} />
              <h2 className={styles.emptyTitle}>No documents in this folder</h2>
              <p className={styles.emptyBody}>Try a different folder, or switch back to All.</p>
            </div>
          )}

          {selectMode && (
            <div className={styles.bulkBar}>
              <span className={styles.bulkCount}>
                {selectedIds.size} selected
              </span>

              <div className={styles.bulkActions}>
                {!confirmingBulkDelete ? (
                  <button
                    type="button"
                    className={styles.bulkDeleteButton}
                    onClick={handleBulkDeleteClick}
                    disabled={selectedIds.size === 0 || bulkDeleting}
                  >
                    <Trash size={16} weight="bold" />
                    <span>Delete</span>
                  </button>
                ) : (
                  <div className={styles.confirmRow}>
                    <span className={styles.confirmLabel}>Delete {selectedIds.size}?</span>
                    <button
                      type="button"
                      className={styles.confirmYes}
                      onClick={handleBulkDeleteClick}
                      disabled={bulkDeleting}
                    >
                      {bulkDeleting ? 'Deleting...' : 'Confirm'}
                    </button>
                    <button
                      type="button"
                      className={styles.confirmNo}
                      onClick={() => setConfirmingBulkDelete(false)}
                      disabled={bulkDeleting}
                    >
                      Cancel
                    </button>
                  </div>
                )}

                <button
                  type="button"
                  className={styles.bulkShareButton}
                  onClick={handleBulkShare}
                  disabled={selectedIds.size !== 1}
                  title={selectedIds.size === 1 ? undefined : 'Select one file to share'}
                >
                  <ShareNetwork size={16} weight="bold" />
                  <span>Share</span>
                </button>

                <button type="button" className={styles.bulkDoneButton} onClick={exitSelectMode}>
                  Done
                </button>
              </div>
            </div>
          )}

          {visibleDocuments.length > 0 && (
            <ul className={styles.list}>
              {visibleDocuments.map((doc) => (
                <DocumentRow
                  key={doc.id}
                  document={doc}
                  onView={handleView}
                  onDelete={handleDelete}
                  onShare={setSharingDocument}
                  onEdit={setEditingDocument}
                  isViewing={viewingId === doc.id}
                  isDeleting={deletingId === doc.id}
                  selectMode={selectMode}
                  selected={selectedIds.has(doc.id)}
                  onToggleSelect={toggleSelected}
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

      {editingDocument && (
        <EditDocumentModal
          document={editingDocument}
          onClose={() => setEditingDocument(null)}
          onSaved={handleEditSaved}
        />
      )}
    </div>
  );
}

export default VaultShell;
