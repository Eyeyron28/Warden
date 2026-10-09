import { useState } from 'react';

import Modal from './Modal.jsx';
import { setDocumentExpiry } from '../services/documentsService.js';
import { extractErrorMessage } from '../services/api.js';
import { EXPIRY_STORAGE_NOTE, expiryDayValue } from '../utils/expiry.js';
import { getTodayDateInputValue } from '../utils/dateInputs.js';
import styles from './EditDocumentModal.module.css';

/**
 * Set, change or clear a file's "Expires on" date (passport, licence, ...). Opened from a file's menu and from
 * the preview's Details panel. Warden emails a reminder 60, 30 and 7 days before and on the day.
 */
function ExpiryModal({ document, onClose, onSaved }) {
  const original = expiryDayValue(document.docExpiresAt || document.expiryDate);
  const [day, setDay] = useState(original);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async (next) => {
    setBusy(true);
    setError('');
    try {
      const updated = await setDocumentExpiry(document.id, next);
      onSaved(updated);
      onClose();
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not save the date. Please try again.'));
      setBusy(false);
    }
  };

  return (
    <Modal title="Expiry date" onClose={() => !busy && onClose()}>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (day && day !== original) save(day);
          else onClose();
        }}
      >
        <p className={styles.hint} title={document.filename}>
          When does <strong>{document.filename}</strong> expire? Warden emails you 60, 30 and 7 days before, and on the day.
        </p>
        <div className={styles.field}>
          <label htmlFor="expiry-day" className={styles.label}>
            Expires on
          </label>
          <input
            id="expiry-day"
            type="date"
            className={styles.textInput}
            value={day}
            onChange={(event) => setDay(event.target.value)}
            min={original && original < getTodayDateInputValue() ? undefined : getTodayDateInputValue()}
            disabled={busy}
            autoFocus
          />
        </div>
        <p className={styles.hint}>{EXPIRY_STORAGE_NOTE}</p>
        <p className={styles.error} role="alert">
          {error || ' '}
        </p>
        <div className={styles.buttonRow}>
          {original && (
            <button type="button" className={styles.cancelButton} onClick={() => save(null)} disabled={busy}>
              Remove date
            </button>
          )}
          <button type="button" className={styles.cancelButton} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={styles.submitButton} disabled={busy || !day}>
            {busy ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default ExpiryModal;
