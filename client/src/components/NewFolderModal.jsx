import { useRef, useState } from 'react';

import FolderStylePicker from './FolderStylePicker.jsx';
import Modal from './Modal.jsx';
import { createFolder } from '../services/documentsService.js';
import { extractErrorMessage } from '../services/api.js';
import { useSingleFlight } from '../utils/useSingleFlight.js';
import styles from './NewFolderModal.module.css';

function errorMessageFor(err) {
  if (!err?.response && err?.message) return err.message;
  return extractErrorMessage(err, 'Could not create this folder.');
}

function NewFolderModal({ onClose, onCreated, currentPath, createFolderFn = createFolder }) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [style, setStyle] = useState({ color: null, icon: null });
  const inputRef = useRef(null);
  const run = useSingleFlight();

  const showError = (message) => {
    setError(message);
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
      await createFolderFn(fullPath, { color: style.color, icon: style.icon });
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
      <form className={styles.form} onSubmit={(event) => {
          event.preventDefault();
          run(() => handleSubmit(event));
        }} noValidate>
        <div className={styles.field}>
          <label data-required htmlFor="new-folder-name" className={styles.label}>
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
          <FolderStylePicker value={style} onChange={setStyle} disabled={submitting} />
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
