import { useRef, useState } from 'react';
import { UploadSimple, X } from '@phosphor-icons/react';

import { getTodayDateInputValue } from '../utils/dateInputs.js';
import styles from './UploadForm.module.css';

/**
 * `destinationLabel` is display-only (e.g. "Documents" or "PC/Projects") -
 * which folder the file lands in is driven entirely by wherever VaultShell
 * is currently showing (currentPath), not a field on this form anymore,
 * matching Drive's own upload behavior: a file always uploads into
 * wherever you're currently looking, not a folder typed by hand.
 */
function UploadForm({ onSubmit, onCancel, uploading, progress, error, destinationLabel }) {
  const [file, setFile] = useState(null);
  const [expiryDate, setExpiryDate] = useState('');
  const fileInputRef = useRef(null);

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!file || uploading) return;
    onSubmit({ file, expiryDate });
  };

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <div className={styles.fileRow}>
        <button
          type="button"
          className={styles.fileButton}
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          <UploadSimple size={16} weight="bold" />
          <span>{file ? file.name : 'Choose a file'}</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          className={styles.hiddenInput}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          disabled={uploading}
        />
      </div>

      {destinationLabel && <p className={styles.destination}>Uploading to: {destinationLabel}</p>}

      <div className={styles.field}>
        <label htmlFor="upload-expiry" className={styles.label}>
          Expiry date (optional)
        </label>
        <input
          id="upload-expiry"
          type="date"
          className={styles.textInput}
          value={expiryDate}
          onChange={(event) => setExpiryDate(event.target.value)}
          min={getTodayDateInputValue()}
          disabled={uploading}
        />
      </div>

      {uploading && (
        <div className={styles.progressTrack} role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
          <div className={styles.progressFill} style={{ width: `${progress}%` }} />
        </div>
      )}

      <p className={styles.error} role="alert">
        {error || ' '}
      </p>

      <div className={styles.buttonRow}>
        <button type="button" className={styles.cancelButton} onClick={onCancel} disabled={uploading}>
          <X size={16} />
          <span>Cancel</span>
        </button>
        <button type="submit" className={styles.submitButton} disabled={!file || uploading}>
          {uploading ? `Encrypting & uploading, ${progress}%` : 'Encrypt & upload'}
        </button>
      </div>
    </form>
  );
}

export default UploadForm;
