import { useEffect, useRef, useState } from 'react';
import { ArrowCounterClockwise, ArrowsOutCardinal, Folder } from '@phosphor-icons/react';

import Modal from './Modal.jsx';
import { updateDocument } from '../services/documentsService.js';
import { extractErrorMessage } from '../services/api.js';
import { getTodayDateInputValue } from '../utils/dateInputs.js';
import { keepExtension, splitName } from '../utils/fileNames.js';
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
 * Edit form for a document's metadata - filename and expiry date. Backed
 * by PATCH /api/documents/:id, which is deliberately metadata-only (see
 * that controller): this form never touches the encrypted file content.
 *
 * The folder is shown read-only with a "Move..." button rather than as an
 * editable field: moving only happens through the Move picker, which
 * enforces the folder rules (no "josh" next to "Josh") and name-conflict
 * checks that a free-text field would bypass.
 */
function EditDocumentModal({ document, onClose, onSaved, onMove }) {
  const [filename, setFilename] = useState(document.filename);
  const nameRef = useRef(null);
  const originalExt = splitName(document.filename).ext;
  const previewName = keepExtension(document.filename, filename);

  // Opens with only the base name selected, so typing replaces "mod12" and leaves ".pdf" alone.
  useEffect(() => {
    const input = nameRef.current;
    if (!input) return;
    const { base } = splitName(document.filename);
    input.setSelectionRange(0, base.length);
  }, [document.filename]);
  const [expiryDate, setExpiryDate] = useState(toDateInputValue(document.expiryDate));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const location = !document.folder || document.folder === 'root' ? 'My Vault' : document.folder;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (submitting) return;

    // The extension stays unless a different one was typed on purpose (see utils/fileNames.js).
    const trimmedFilename = keepExtension(document.filename, filename);
    if (!trimmedFilename) {
      setError('Filename cannot be empty.');
      return;
    }

    const originalExpiryValue = toDateInputValue(document.expiryDate);

    // Only send fields that actually changed, matching the backend's
    // partial-update design - a filename-only edit shouldn't also resend
    // expiryDate just because the form has a field for it.
    const updates = {};
    if (trimmedFilename !== document.filename) updates.filename = trimmedFilename;
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
            ref={nameRef}
            autoFocus
            aria-describedby="edit-filename-hint"
          />
          <p id="edit-filename-hint" className={styles.hint}>
            {originalExt
              ? previewName === filename.trim()
                ? `Extension: .${originalExt}. Type a different extension to change it, or end the name with a dot to remove it.`
                : filename.trim().endsWith('.')
                  ? `Will be saved as “${previewName}”, without an extension.`
                  : `Will be saved as “${previewName}” (the .${originalExt} extension is kept).`
              : 'This file has no extension.'}
          </p>
        </div>

        <div className={styles.field}>
          <span className={styles.label} id="edit-location-label">
            Location
          </span>
          <div className={styles.locationRow}>
            <span className={styles.location} aria-labelledby="edit-location-label">
              <Folder size={16} weight="fill" aria-hidden="true" />
              <span className={styles.locationText}>{location}</span>
            </span>
            {onMove && (
              <button
                type="button"
                className={styles.moveButton}
                onClick={() => onMove(document)}
                disabled={submitting}
              >
                <ArrowsOutCardinal size={14} />
                <span>Move...</span>
              </button>
            )}
          </div>
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
