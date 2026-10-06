import { useEffect, useRef, useState } from 'react';

import Modal from './Modal.jsx';
import { renameFolder } from '../services/documentsService.js';
import { extractErrorMessage } from '../services/api.js';
import styles from './NewFolderModal.module.css';

/**
 * Rename from a folder tile's "⋯" menu. Same rules and same error
 * behavior as New folder: a clash with a sibling (any casing) is a 409
 * FOLDER_EXISTS shown under the input, and the dialog stays open with the
 * typed value. Everything nested inside follows the new name server-side.
 */
function RenameFolderModal({ path, onClose, onRenamed }) {
  const currentName = path.split('/').pop();
  const [name, setName] = useState(currentName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    if (trimmed === currentName) {
      onClose();
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const { path: newPath } = await renameFolder(path, trimmed);
      onRenamed(path, newPath);
      onClose();
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not rename this folder.'));
      requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title={`Rename "${currentName}"`} onClose={onClose}>
      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <div className={styles.field}>
          <label htmlFor="rename-folder-name" className={styles.label}>
            Folder name
          </label>
          <input
            ref={inputRef}
            id="rename-folder-name"
            type="text"
            className={`${styles.textInput} ${error ? styles.textInputError : ''}`}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (error) setError('');
            }}
            maxLength={100}
            disabled={submitting}
            aria-invalid={Boolean(error)}
            aria-describedby="rename-folder-error"
            autoFocus
          />
        </div>

        <p id="rename-folder-error" className={styles.error} role="alert" aria-live="assertive">
          {error || ' '}
        </p>

        <div className={styles.buttonRow}>
          <button type="button" className={styles.cancelButton} onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className={styles.submitButton} disabled={!name.trim() || submitting}>
            {submitting ? 'Renaming...' : 'Rename'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default RenameFolderModal;
