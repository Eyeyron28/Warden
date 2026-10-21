import { useEffect, useRef, useState } from 'react';
import { ArrowCounterClockwise, ArrowsOutCardinal, Folder } from '@phosphor-icons/react';

import Modal from './Modal.jsx';
import { updateDocument } from '../services/documentsService.js';
import { extractErrorMessage } from '../services/api.js';
import { getTodayDateInputValue } from '../utils/dateInputs.js';
import { keepExtension, splitName } from '../utils/fileNames.js';
import { EXPIRY_STORAGE_NOTE } from '../utils/expiry.js';
import { useSingleFlight } from '../utils/useSingleFlight.js';
import styles from './EditDocumentModal.module.css';

function toDateInputValue(isoExpiryDate) {
  return isoExpiryDate ? isoExpiryDate.slice(0, 10) : '';
}

function EditDocumentModal({ document, onClose, onSaved, onMove }) {
  const [filename, setFilename] = useState(document.filename);
  const nameRef = useRef(null);
  const originalExt = splitName(document.filename).ext;
  const previewName = keepExtension(document.filename, filename);

  useEffect(() => {
    const input = nameRef.current;
    if (!input) return;
    const { base } = splitName(document.filename);
    input.setSelectionRange(0, base.length);
  }, [document.filename]);
  const [expiryDate, setExpiryDate] = useState(toDateInputValue(document.expiryDate));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const run = useSingleFlight();
  const location = !document.folder || document.folder === 'root' ? 'My Vault' : document.folder;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (submitting) return;

    const trimmedFilename = keepExtension(document.filename, filename);
    if (!trimmedFilename) {
      setError('Filename cannot be empty.');
      return;
    }

    const originalExpiryValue = toDateInputValue(document.expiryDate);

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
      <form className={styles.form} onSubmit={(event) => {
          event.preventDefault();
          run(() => handleSubmit(event));
        }} noValidate>
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
          <p className={styles.hint}>{EXPIRY_STORAGE_NOTE}</p>
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
