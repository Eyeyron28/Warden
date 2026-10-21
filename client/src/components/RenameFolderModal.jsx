import { useEffect, useRef, useState } from 'react';

import FolderStylePicker from './FolderStylePicker.jsx';
import Modal from './Modal.jsx';
import { renameFolder } from '../services/documentsService.js';
import { extractErrorMessage } from '../services/api.js';
import { getFolderStyles } from '../services/folderStyles.js';
import { useSingleFlight } from '../utils/useSingleFlight.js';
import styles from './NewFolderModal.module.css';

function RenameFolderModal({ path, onClose, onRenamed }) {
  const currentName = path.split('/').pop();
  const [name, setName] = useState(currentName);
  const current = getFolderStyles()[path];
  const startStyle = { color: current?.color ?? null, icon: current?.icon ?? null };
  const [style, setStyle] = useState(startStyle);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const run = useSingleFlight();

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    const styleChanged = style.color !== startStyle.color || style.icon !== startStyle.icon;
    if (trimmed === currentName && !styleChanged) {
      onClose();
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const { path: newPath } = await renameFolder(path, trimmed === currentName ? undefined : trimmed, styleChanged ? style : {});
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
      <form className={styles.form} onSubmit={(event) => {
          event.preventDefault();
          run(() => handleSubmit(event));
        }} noValidate>
        <div className={styles.field}>
          <label data-required htmlFor="rename-folder-name" className={styles.label}>
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

        <FolderStylePicker value={style} onChange={setStyle} disabled={submitting} />

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
