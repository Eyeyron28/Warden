import { useState } from 'react';
import { CheckCircle, Info, Warning } from '@phosphor-icons/react';

import styles from './RestorePanel.module.css';

/**
 * Restore is additive-only (the backend dedupes by checksum and never
 * touches an existing document), so its confirm step follows the same
 * click-to-arm-then-confirm interaction as document delete, but without
 * delete's danger-red styling - there's genuinely nothing destructive to
 * warn about here, just a disk read + DB write worth a deliberate second
 * click.
 */
function RestorePanel({ onSubmit, onCancel, submitting, error, result }) {
  const [sourcePath, setSourcePath] = useState('');
  const [confirming, setConfirming] = useState(false);

  const handlePathChange = (event) => {
    setSourcePath(event.target.value);
    setConfirming(false);
  };

  const handleArmConfirm = (event) => {
    event.preventDefault();
    if (!sourcePath.trim() || submitting) return;
    setConfirming(true);
  };

  const handleConfirm = () => {
    setConfirming(false);
    onSubmit(sourcePath.trim());
  };

  if (result) {
    return (
      <div className={styles.panel}>
        <div className={styles.successBanner}>
          <CheckCircle size={20} weight="fill" className={styles.successIcon} />
          <div className={styles.successCopy}>
            <p className={styles.successTitle}>Restore complete</p>
            <p className={styles.successBody}>
              {result.documentsImported} document{result.documentsImported === 1 ? '' : 's'} restored,{' '}
              {result.documentsSkipped} already existed and {result.documentsSkipped === 1 ? 'was' : 'were'}{' '}
              skipped.
            </p>
          </div>
        </div>

        {result.note && (
          <div className={styles.infoNote}>
            <Info size={16} weight="bold" className={styles.infoIcon} />
            <p>{result.note}</p>
          </div>
        )}

        <div className={styles.buttonRow}>
          <button type="button" className={styles.cancelButton} onClick={onCancel}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className={styles.panel} onSubmit={handleArmConfirm}>
      <div className={styles.field}>
        <label htmlFor="restore-source" className={styles.label}>
          Source path
        </label>
        <input
          id="restore-source"
          type="text"
          className={styles.textInput}
          value={sourcePath}
          onChange={handlePathChange}
          placeholder={'E:\\warden-backup'}
          disabled={submitting}
          autoFocus
        />
        <p className={styles.helper}>
          Enter the path to the warden-backup folder itself (the folder your export created), e.g.
          E:\warden-backup for a USB drive.
        </p>
      </div>

      <div className={styles.warningNote}>
        <Warning size={16} weight="bold" className={styles.warningIcon} />
        <p>
          This will add any documents from the backup that aren't already in your vault. Existing
          documents won't be duplicated or changed.
        </p>
      </div>

      <p className={styles.error} role="alert">
        {error || ' '}
      </p>

      {!confirming ? (
        <div className={styles.buttonRow}>
          <button type="button" className={styles.cancelButton} onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className={styles.submitButton} disabled={!sourcePath.trim() || submitting}>
            Restore
          </button>
        </div>
      ) : (
        <div className={styles.confirmRow}>
          <span className={styles.confirmLabel}>Restore from this path?</span>
          <div className={styles.confirmButtons}>
            <button type="button" className={styles.cancelButton} onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" className={styles.submitButton} onClick={handleConfirm} disabled={submitting}>
              {submitting ? 'Restoring...' : 'Confirm restore'}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}

export default RestorePanel;
