import { useRef, useState } from 'react';

import Modal from './Modal.jsx';
import { createFolder } from '../services/documentsService.js';
import { extractErrorMessage } from '../services/api.js';
import styles from './NewFolderModal.module.css';

// A thrown Error from a local (non-HTTP) createFolderFn - the phone's own
// IndexedDB-backed version - has no response body for extractErrorMessage
// to read, so its own message is used instead.
function errorMessageFor(err) {
  if (!err?.response && err?.message) return err.message;
  return extractErrorMessage(err, 'Could not create this folder.');
}

/**
 * "New folder" from the "+ New" menu. Always creates a single new segment
 * inside `currentPath` (wherever the vault is currently showing), matching
 * Drive's own "New folder" dialog - typing a name with "/" in it would
 * silently create nested folders instead of one, so that's rejected
 * outright rather than silently reinterpreted.
 *
 * A failed create - most often 409 FOLDER_EXISTS, "Josh" already being
 * there in any casing - never closes the dialog: the server's message is
 * shown under the input, the typed name stays, and focus returns to the
 * input so it can be fixed straight away.
 */
function NewFolderModal({ onClose, onCreated, currentPath, createFolderFn = createFolder }) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  const showError = (message) => {
    setError(message);
    // After the re-render that re-enables the input.
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;

    if (/[\\/]/.test(trimmed)) {
      showError('Folder names can\'t contain "/" or "\\".');
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
      showError(errorMessageFor(err));
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
            ref={inputRef}
            id="new-folder-name"
            type="text"
            className={`${styles.textInput} ${error ? styles.textInputError : ''}`}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (error) setError('');
            }}
            placeholder="e.g. Taxes"
            maxLength={100}
            disabled={submitting}
            aria-invalid={Boolean(error)}
            aria-describedby="new-folder-error"
            autoFocus
          />
          <p className={styles.helper}>
            {currentPath ? `Creates inside "${currentPath}".` : 'Creates at the top level.'}
          </p>
        </div>

        <p id="new-folder-error" className={styles.error} role="alert" aria-live="assertive">
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
