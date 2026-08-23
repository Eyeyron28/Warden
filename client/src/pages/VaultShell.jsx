import { useCallback, useEffect, useState } from 'react';
import { FolderLock, Plus } from '@phosphor-icons/react';

import Header from '../components/Header.jsx';
import DocumentRow from '../components/DocumentRow.jsx';
import UploadForm from '../components/UploadForm.jsx';
import {
  listDocuments,
  uploadDocument,
  fetchDocumentBlob,
  openBlob,
  deleteDocument,
} from '../services/documentsService.js';
import { extractErrorMessage } from '../services/api.js';
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

  const refresh = useCallback(async () => {
    setLoading(true);
    setListError('');
    try {
      const data = await listDocuments();
      setDocuments(data);
    } catch (err) {
      if (!isSessionExpired(err)) {
        setListError(extractErrorMessage(err, 'Could not load your documents.'));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
            <button
              type="button"
              className={styles.addButton}
              onClick={() => setUploadOpen((open) => !open)}
            >
              <Plus size={16} weight="bold" />
              <span>Add document</span>
            </button>
          </div>

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
                  isViewing={viewingId === doc.id}
                  isDeleting={deletingId === doc.id}
                />
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}

export default VaultShell;
