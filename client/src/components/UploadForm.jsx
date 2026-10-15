import { useEffect, useRef, useState } from 'react';
import { UploadSimple, X } from '@phosphor-icons/react';

import FileNameLabel from './FileNameLabel.jsx';
import { getTodayDateInputValue } from '../utils/dateInputs.js';
import { formatBytes } from '../utils/listing.js';
import styles from './UploadForm.module.css';

/** Whole seconds since `active` turned on (0 while it is off). */
function useElapsedSeconds(active) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return undefined;
    }
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [active]);
  return seconds;
}

/**
 * `destinationLabel` is display-only (e.g. "Documents" or "PC/Projects") -
 * which folder the file lands in is driven entirely by wherever VaultShell
 * is currently showing (currentPath), not a field on this form anymore,
 * matching Drive's own upload behavior: a file always uploads into
 * wherever you're currently looking, not a folder typed by hand.
 *
 * Pressing "Encrypt & upload" locks the form in the same instant (a ref, before any await), so Enter twice, a double click or two
 * taps send ONE request. While it runs the label says so, the bar shows the real number of bytes sent, and when everything has
 * been sent but the answer has not come (the server is encrypting and storing) the bar is indeterminate with a running clock.
 * Cancel during the upload aborts the request (`onAbort`).
 */
function UploadForm({ onSubmit, onCancel, onAbort, uploading, progress, error, destinationLabel }) {
  const [file, setFile] = useState(null);
  const [expiryDate, setExpiryDate] = useState('');
  const [locked, setLocked] = useState(false);
  const fileInputRef = useRef(null);
  const lock = useRef(false);

  const busy = uploading || locked;
  const seconds = useElapsedSeconds(busy);
  const sent = busy && progress >= 100;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!file || lock.current) return;
    lock.current = true; // synchronous: a second event in the same tick finds it set
    setLocked(true);
    try {
      await onSubmit({ file, expiryDate });
    } finally {
      lock.current = false;
      setLocked(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={handleSubmit} aria-busy={busy}>
      <div className={styles.fileRow}>
        <button
          type="button"
          className={styles.fileButton}
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          title={file ? file.name : undefined}
          aria-label={file ? `Chosen file ${file.name}, ${formatBytes(file.size)}. Choose a different file.` : 'Choose a file'}
        >
          <UploadSimple size={16} weight="bold" className={styles.fileIcon} />
          {file ? (
            <span className={styles.fileLabel}>
              <FileNameLabel name={file.name} />
              <span className={styles.fileSize}>{formatBytes(file.size)}</span>
            </span>
          ) : (
            <span className={styles.fileLabel}>Choose a file</span>
          )}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          className={styles.hiddenInput}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          disabled={busy}
          tabIndex={-1}
          aria-hidden="true"
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
          disabled={busy}
        />
      </div>

      {busy && (
        <div className={styles.progress} role="status" aria-live="polite">
          <div
            className={`${styles.progressTrack} ${sent ? styles.indeterminate : ''}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={sent ? undefined : progress}
            aria-label="Upload progress"
          >
            <div className={styles.progressFill} style={sent ? undefined : { width: `${progress}%` }} />
          </div>
          <p className={styles.progressText}>
            {sent ? 'Sent. Encrypting and saving on the server' : `Sending ${progress}%`}
            {' · '}
            {seconds} s
          </p>
        </div>
      )}

      <p className={styles.error} role="alert">
        {error || ' '}
      </p>

      <div className={styles.buttonRow}>
        <button type="button" className={styles.cancelButton} onClick={busy ? onAbort : onCancel}>
          <X size={16} />
          <span>{busy ? 'Cancel upload' : 'Cancel'}</span>
        </button>
        <button type="submit" className={styles.submitButton} disabled={!file || busy}>
          {busy ? 'Encrypting and uploading…' : 'Encrypt & upload'}
        </button>
      </div>
    </form>
  );
}

export default UploadForm;
