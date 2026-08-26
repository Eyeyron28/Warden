import { useCallback, useEffect, useState } from 'react';

import {
  saveDocumentLocally,
  getAllLocalDocuments,
  deleteLocalDocument,
} from '../services/localVault.js';
import styles from './DevLocalVault.module.css';

/**
 * TEMPORARY, developer-only test view for the IndexedDB local-vault
 * storage layer (services/localVault.js). It exists only to verify that
 * layer works in isolation - saving a sample record, listing what's
 * stored, deleting one - before real pairing/sync wires anything actual
 * into it. Delete this page, its route in App.jsx (guarded to dev builds
 * only), and DevLocalVault.module.css once that next pass lands.
 */
function DevLocalVault() {
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const docs = await getAllLocalDocuments();
      docs.sort((a, b) => new Date(b.cachedAt) - new Date(a.cachedAt));
      setDocuments(docs);
    } catch (err) {
      setError(err.message || 'Could not read local storage.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSaveSample = async () => {
    const id = crypto.randomUUID();
    // A small, genuinely random binary payload - not real encrypted file
    // content, just something that exercises the same ArrayBuffer storage
    // path a real encryptedBlob would use.
    const encryptedBlob = crypto.getRandomValues(new Uint8Array(32)).buffer;

    await saveDocumentLocally({
      id,
      filename: `sample-${id.slice(0, 8)}.txt`,
      folder: 'root',
      expiryDate: null,
      encryptedBlob,
      iv: crypto.randomUUID(),
      authTag: crypto.randomUUID(),
      checksum: crypto.randomUUID(),
      syncStatus: 'pending',
    });
    await refresh();
  };

  const handleDelete = async (id) => {
    await deleteLocalDocument(id);
    await refresh();
  };

  return (
    <div className={styles.page}>
      <p className={styles.banner}>
        Developer-only test view for the IndexedDB local-vault storage layer. Not part of the real
        app flow - temporary, until pairing/sync lands.
      </p>

      <div className={styles.panel}>
        <div className={styles.header}>
          <h1 className={styles.title}>Local vault storage (IndexedDB)</h1>
          <button type="button" className={styles.saveButton} onClick={handleSaveSample}>
            Save sample document
          </button>
        </div>

        {loading && <p className={styles.hint}>Loading...</p>}
        {error && <p className={styles.error}>{error}</p>}

        {!loading && documents.length === 0 && (
          <p className={styles.hint}>Nothing stored locally yet.</p>
        )}

        {!loading && documents.length > 0 && (
          <ul className={styles.list}>
            {documents.map((doc) => (
              <li key={doc.id} className={styles.row}>
                <div className={styles.meta}>
                  <span className={styles.filename}>{doc.filename}</span>
                  <span className={styles.sub}>
                    {doc.id} · {doc.encryptedBlob?.byteLength ?? 0} bytes · cached{' '}
                    {new Date(doc.cachedAt).toLocaleString()}
                  </span>
                </div>
                <button
                  type="button"
                  className={styles.deleteButton}
                  onClick={() => handleDelete(doc.id)}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default DevLocalVault;
