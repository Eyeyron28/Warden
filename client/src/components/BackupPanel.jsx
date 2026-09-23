import { useState } from 'react';
import { CheckCircle } from '@phosphor-icons/react';

import { formatDateTime } from '../utils/formatDate.js';
import styles from './BackupPanel.module.css';

const MIN_USB_PASSPHRASE_LENGTH = 4; // same floor as the phone pairing PIN

function BackupPanel({ onSubmit, onCancel, submitting, error, result }) {
  const [targetPath, setTargetPath] = useState('');
  // Same shape as setting a phone PIN at pairing time: a set + confirm
  // pair, so a typo doesn't lock the owner out of their own USB recovery
  // path without them noticing. This passphrase is set fresh on every
  // export (see PairDevicePanel's phonePin for the same one-time-per-
  // pairing spirit) - there's no "forgot the USB passphrase" recovery of
  // its own, so catching a typo here matters.
  const [usbPassphrase, setUsbPassphrase] = useState('');
  const [confirmUsbPassphrase, setConfirmUsbPassphrase] = useState('');

  const passphraseTooShort =
    usbPassphrase.length > 0 && usbPassphrase.length < MIN_USB_PASSPHRASE_LENGTH;
  const passphraseMismatch =
    confirmUsbPassphrase.length > 0 && usbPassphrase !== confirmUsbPassphrase;
  const isFormValid =
    targetPath.trim().length > 0 &&
    usbPassphrase.length >= MIN_USB_PASSPHRASE_LENGTH &&
    usbPassphrase === confirmUsbPassphrase;

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!isFormValid || submitting) return;
    onSubmit(targetPath.trim(), usbPassphrase);
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

      <div className={styles.field}>
        <label htmlFor="usb-passphrase" className={styles.label}>
          USB recovery passphrase
        </label>
        <input
          id="usb-passphrase"
          type="password"
          className={styles.textInput}
          value={usbPassphrase}
          onChange={(event) => setUsbPassphrase(event.target.value)}
          placeholder="At least 4 characters"
          autoComplete="off"
          disabled={submitting}
        />
        {passphraseTooShort && (
          <p className={styles.helper}>Must be at least {MIN_USB_PASSPHRASE_LENGTH} characters.</p>
        )}
      </div>

      <div className={styles.field}>
        <label htmlFor="usb-passphrase-confirm" className={styles.label}>
          Confirm passphrase
        </label>
        <input
          id="usb-passphrase-confirm"
          type="password"
          className={styles.textInput}
          value={confirmUsbPassphrase}
          onChange={(event) => setConfirmUsbPassphrase(event.target.value)}
          placeholder="Re-enter passphrase"
          autoComplete="off"
          disabled={submitting}
        />
        {passphraseMismatch && <p className={styles.helper}>Passphrases don't match.</p>}
        <p className={styles.helper}>
          This lets you reset your master password later using only this backup and this
          passphrase - separate from your recovery key, and set fresh on every export. There's no
          way to recover it if forgotten, so write it down somewhere safe.
        </p>
      </div>

      <p className={styles.error} role="alert">
        {error || ' '}
      </p>

      <div className={styles.buttonRow}>
        <button type="button" className={styles.cancelButton} onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className={styles.submitButton} disabled={!isFormValid || submitting}>
          {submitting ? 'Backing up...' : 'Start backup'}
        </button>
      </div>
    </form>
  );
}

export default BackupPanel;
