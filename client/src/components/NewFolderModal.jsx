import { useState } from 'react';

import Modal from './Modal.jsx';
import { createFolder } from '../services/documentsService.js';
import { extractErrorMessage } from '../services/api.js';
import styles from './NewFolderModal.module.css';

/**
 * "New folder" from the "+ New" menu. Creates an empty folder
 * (POST /api/documents/folders) so it shows up as a tile in the Drive-
 * style folder grid before any document is filed into it - onCreated
 * tells VaultShell to refresh the folder list, nothing else about the
 * document list changes. Always creates a single new segment inside
 * `currentPath` (wherever VaultShell is currently showing), matching
 * Drive's own "New folder" dialog - typing a name with "/" in it would
 * silently create nested folders instead of one, so that's rejected
 * outright rather than silently reinterpreted.
 */
function NewFolderModal({ onClose, onCreated, currentPath, createFolderFn = createFolder }) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (event) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;

    if (trimmed.includes('/')) {
      setError('Folder names can\'t contain "/".');
      return;
    }

    const fullPath = currentPath ? `${currentPath}/${trimmed}` : trimmed;

    setSubmitting(true);
    setError('');
    try {
      await createFolderFn(fullPath);
      onCreated(fullPath);
      onClose();
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not create this folder.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="New folder" onClose={onClose}>
      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <div className={styles.field}>
          <label htmlFor="new-folder-name" className={styles.label}>
            Folder name
          </label>
          <input
            id="new-folder-name"
            type="text"
            className={styles.textInput}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Taxes"
            disabled={submitting}
            autoFocus
          />
          <p className={styles.helper}>
            {currentPath ? `Creates inside "${currentPath}".` : 'Creates at the top level.'}
          </p>
        </div>

        <p className={styles.error} role="alert">
          {error || ' '}
        </p>

        <div className={styles.buttonRow}>
          <button type="button" className={styles.cancelButton} onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className={styles.submitButton} disabled={!name.trim() || submitting}>
            {submitting ? 'Creating...' : 'Create folder'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default NewFolderModal;
