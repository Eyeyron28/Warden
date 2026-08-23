import { useState } from 'react';
import { CheckCircle } from '@phosphor-icons/react';

import { formatDateTime } from '../utils/formatDate.js';
import styles from './BackupPanel.module.css';

function BackupPanel({ onSubmit, onCancel, submitting, error, result }) {
  const [targetPath, setTargetPath] = useState('');

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!targetPath.trim() || submitting) return;
    onSubmit(targetPath.trim());
  };

  if (result) {
    return (
      <div className={styles.panel}>
        <div className={styles.successBanner}>
          <CheckCircle size={20} weight="fill" className={styles.successIcon} />
          <div className={styles.successCopy}>
            <p className={styles.successTitle}>Backup complete</p>
            <p className={styles.successBody}>
              {result.documentsBackedUp} document{result.documentsBackedUp === 1 ? '' : 's'} backed up
              to <code className={styles.path}>{result.backupPath}</code>
            </p>
            <p className={styles.successMeta}>{formatDateTime(result.timestamp)}</p>
          </div>
        </div>
        <div className={styles.buttonRow}>
          <button type="button" className={styles.cancelButton} onClick={onCancel}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className={styles.panel} onSubmit={handleSubmit}>
      <div className={styles.field}>
        <label htmlFor="backup-target" className={styles.label}>
          Target path
        </label>
        <input
          id="backup-target"
          type="text"
          className={styles.textInput}
          value={targetPath}
          onChange={(event) => setTargetPath(event.target.value)}
          placeholder={'E:\\'}
          disabled={submitting}
          autoFocus
        />
        <p className={styles.helper}>
          Enter the drive letter or folder path where you want to save your backup, e.g. E:\ for a
          USB drive.
        </p>
      </div>

      <p className={styles.error} role="alert">
        {error || ' '}
      </p>

      <div className={styles.buttonRow}>
        <button type="button" className={styles.cancelButton} onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className={styles.submitButton} disabled={!targetPath.trim() || submitting}>
          {submitting ? 'Backing up...' : 'Start backup'}
        </button>
      </div>
    </form>
  );
}

export default BackupPanel;
