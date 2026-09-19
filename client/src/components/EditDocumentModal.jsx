import { useEffect, useState } from 'react';
import { ArrowCounterClockwise } from '@phosphor-icons/react';

import Modal from './Modal.jsx';
import { updateDocument, listFolders } from '../services/documentsService.js';
import { extractErrorMessage } from '../services/api.js';
import { getTodayDateInputValue } from '../utils/dateInputs.js';
import styles from './EditDocumentModal.module.css';

// document.expiryDate arrives as an ISO string (e.g.
// "2026-12-31T00:00:00.000Z") from the backend, always UTC midnight for
// a date-only field - slicing the first 10 characters gives the native
// <input type="date"> value directly, with no timezone conversion to get
// wrong (going through `new Date(...)` and reading local components
// could shift the date by a day for some timezones).
function toDateInputValue(isoExpiryDate) {
  return isoExpiryDate ? isoExpiryDate.slice(0, 10) : '';
}

/**
 * Edit form for a document's metadata - filename, folder, expiry date.
 * Backed by PATCH /api/documents/:id, which is deliberately metadata-only
 * (see that controller): this form never touches the encrypted file
 * content, so it doesn't need the vault to do anything with it either.
 *
 * The folder field is a native <input list> combobox rather than a
 * custom dropdown: it accepts free text (so a folder can still be
 * created by typing a new name) while suggesting existing folders from
 * GET /api/documents/folders, cutting down on near-duplicate folders
 * from typos - with no new dependency and full keyboard/accessibility
 * support for free.
 */
function EditDocumentModal({ document, onClose, onSaved }) {
  const [filename, setFilename] = useState(document.filename);
  const [folder, setFolder] = useState(document.folder || 'root');
  const [expiryDate, setExpiryDate] = useState(toDateInputValue(document.expiryDate));
  const [folderOptions, setFolderOptions] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    listFolders()
      .then((data) => {
        if (!cancelled) setFolderOptions(data);
      })
      .catch(() => {
        // Folder suggestions are a convenience, not required to edit - a
        // failed fetch just leaves the datalist empty, free text still works.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (submitting) return;

    const trimmedFilename = filename.trim();
    if (!trimmedFilename) {
      setError('Filename cannot be empty.');
      return;
    }

    const trimmedFolder = folder.trim() || 'root';
    const originalFolder = document.folder || 'root';
    const originalExpiryValue = toDateInputValue(document.expiryDate);

    // Only send fields that actually changed, matching the backend's
    // partial-update design - a filename-only edit shouldn't also resend
    // folder/expiryDate just because the form has fields for them.
    const updates = {};
    if (trimmedFilename !== document.filename) updates.filename = trimmedFilename;
    if (trimmedFolder !== originalFolder) updates.folder = trimmedFolder;
    if (expiryDate !== originalExpiryValue) updates.expiryDate = expiryDate || null;

    if (Object.keys(updates).length === 0) {
      onClose();
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const updated = await updateDocument(document.id, updates);
      onSaved(updated);
      onClose();
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not save changes.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title={`Edit "${document.filename}"`} onClose={onClose}>
      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <div className={styles.field}>
          <label htmlFor="edit-filename" className={styles.label}>
            Filename
          </label>
          <input
            id="edit-filename"
            type="text"
            className={styles.textInput}
            value={filename}
            onChange={(event) => setFilename(event.target.value)}
            disabled={submitting}
            autoFocus
          />
        </div>

        <div className={styles.field}>
          <label htmlFor="edit-folder" className={styles.label}>
            Folder
          </label>
          <input
            id="edit-folder"
            type="text"
            list="edit-folder-options"
            className={styles.textInput}
            value={folder}
            onChange={(event) => setFolder(event.target.value)}
            disabled={submitting}
            autoComplete="off"
          />
          <datalist id="edit-folder-options">
            {folderOptions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>

        <div className={styles.field}>
          <label htmlFor="edit-expiry" className={styles.label}>
            Expiry date
          </label>
          <div className={styles.expiryRow}>
            <input
              id="edit-expiry"
              type="date"
              className={styles.textInput}
              value={expiryDate}
              onChange={(event) => setExpiryDate(event.target.value)}
              min={getTodayDateInputValue()}
              disabled={submitting}
            />
            {expiryDate && (
              <button
                type="button"
                className={styles.removeExpiryButton}
                onClick={() => setExpiryDate('')}
                disabled={submitting}
              >
                <ArrowCounterClockwise size={14} />
                <span>Remove expiry</span>
              </button>
            )}
          </div>
        </div>

        <p className={styles.error} role="alert">
          {error || ' '}
        </p>

        <div className={styles.buttonRow}>
          <button type="button" className={styles.cancelButton} onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className={styles.submitButton} disabled={submitting}>
            {submitting ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default EditDocumentModal;
