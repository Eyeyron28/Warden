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
function RestorePanel({ onSubmit, onCancel, submitting, error, result, requirePassword = false }) {
  const [sourcePath, setSourcePath] = useState('');
  const [password, setPassword] = useState('');
  const [confirming, setConfirming] = useState(false);

  const isFormValid = sourcePath.trim().length > 0 && (!requirePassword || password.length > 0);

  const handlePathChange = (event) => {
    setSourcePath(event.target.value);
    setConfirming(false);
  };

  const handleArmConfirm = (event) => {
    event.preventDefault();
    if (!isFormValid || submitting) return;
    setConfirming(true);
  };

  const handleConfirm = () => {
    setConfirming(false);
    onSubmit(sourcePath.trim(), requirePassword ? password : undefined);
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

      {requirePassword && (
        <div className={styles.field}>
          <label htmlFor="restore-password" className={styles.label}>
            This backup's master password
          </label>
          <input
            id="restore-password"
            type="password"
            className={styles.textInput}
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setConfirming(false);
            }}
            placeholder="Enter the password used when this backup was made"
            disabled={submitting}
            autoComplete="off"
          />
          <p className={styles.helper}>
            There's no vault set up on this install yet, so this restores the original vault's key
            material along with its documents - the password that created this backup proves it's
            yours.
          </p>
        </div>
      )}

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
          <button type="submit" className={styles.submitButton} disabled={!isFormValid || submitting}>
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
