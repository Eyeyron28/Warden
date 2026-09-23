import { useRef, useState } from 'react';
import { ArrowRight, FolderOpen } from '@phosphor-icons/react';

import Modal from './Modal.jsx';
import PasswordField from './PasswordField.jsx';
import PasswordStrengthMeter from './PasswordStrengthMeter.jsx';
import { recoverViaUsb } from '../services/authService.js';
import { extractErrorMessage } from '../services/api.js';
import { validatePassword } from '../utils/passwordPolicy.js';
import styles from './UsbRecoveryModal.module.css';

const MIN_USB_PASSPHRASE_LENGTH = 4; // same floor as the phone pairing PIN

// The exact field names POST /api/backup/export writes into
// backup-manifest.json (server/controllers/backup.controller.js).
const MANIFEST_DEK_FIELDS = ['wrappedDEKUsb', 'wrappedDEKUsbIv', 'wrappedDEKUsbAuthTag', 'wrappedDEKUsbSalt'];

/**
 * LockScreen's "Recover with USB" entry point. Reads backup-manifest.json
 * directly from the selected folder client-side (via a plain
 * webkitdirectory file input - same technique NewMenu.jsx's "Upload
 * folder" already uses) rather than sending a path to the backend: unlike
 * the existing backup export/import flow, this runs with no session at
 * all, so there's no authenticated route to ask the backend to go read a
 * path on this owner's behalf. POST /api/auth/recover-via-usb only ever
 * receives the already-extracted wrapped-DEK fields, never a filesystem
 * path - it doesn't touch disk itself.
 */
function UsbRecoveryModal({ onClose, onRecovered }) {
  const [manifestFields, setManifestFields] = useState(null);
  const [folderError, setFolderError] = useState('');
  const [folderName, setFolderName] = useState('');

  const [usbPassphrase, setUsbPassphrase] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [confirmError, setConfirmError] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const fileInputRef = useRef(null);

  const handleFolderChange = async (event) => {
    const files = event.target.files;
    setFolderError('');
    setManifestFields(null);
    setFolderName('');
    if (!files || files.length === 0) return;

    const manifestFile = [...files].find((file) => file.name === 'backup-manifest.json');
    if (!manifestFile) {
      setFolderError(
        'Could not find backup-manifest.json in that folder - select the warden-backup folder itself.'
      );
      return;
    }

    let manifest;
    try {
      manifest = JSON.parse(await manifestFile.text());
    } catch {
      setFolderError('Could not read backup-manifest.json - the file may be corrupted.');
      return;
    }

    if (!MANIFEST_DEK_FIELDS.every((field) => typeof manifest[field] === 'string' && manifest[field])) {
      setFolderError(
        'This backup does not include USB recovery data - it may have been made before USB recovery support was added.'
      );
      return;
    }

    setManifestFields({
      wrappedDEK: manifest.wrappedDEKUsb,
      wrappedDEKIv: manifest.wrappedDEKUsbIv,
      wrappedDEKAuthTag: manifest.wrappedDEKUsbAuthTag,
      wrappedDEKSalt: manifest.wrappedDEKUsbSalt,
    });
    setFolderName(manifestFile.webkitRelativePath.split('/')[0] || 'warden-backup');
  };

  const policy = validatePassword(newPassword);
  const canSubmit =
    Boolean(manifestFields) &&
    usbPassphrase.length >= MIN_USB_PASSPHRASE_LENGTH &&
    policy.valid &&
    confirmPassword.length > 0 &&
    newPassword === confirmPassword &&
    !submitting;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!canSubmit) return;

    setConfirmError('');
    if (newPassword !== confirmPassword) {
      setConfirmError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const { sessionToken } = await recoverViaUsb({
        ...manifestFields,
        usbPassphrase,
        newPassword,
      });
      onRecovered(sessionToken);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not recover the vault.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Recover with USB backup" onClose={onClose}>
      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <div className={styles.field}>
          <span className={styles.label}>Backup folder</span>
          <button
            type="button"
            className={styles.folderButton}
            onClick={() => fileInputRef.current?.click()}
          >
            <FolderOpen size={16} weight="bold" />
            <span>{folderName ? `${folderName} selected` : 'Choose your warden-backup folder'}</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            className={styles.hiddenInput}
            onChange={handleFolderChange}
            webkitdirectory=""
            mozdirectory=""
          />
          {folderError && <p className={styles.fieldError}>{folderError}</p>}
        </div>

        {manifestFields && (
          <>
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
                placeholder="The passphrase you set when backing up"
                autoComplete="off"
                autoFocus
              />
            </div>

            <PasswordField
              label="New master password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Enter a new strong password"
              error={error}
            />

            <PasswordStrengthMeter password={newPassword} />

            <PasswordField
              label="Confirm new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter password"
              error={confirmError}
            />
          </>
        )}

        {!manifestFields && (
          <p className={styles.error} role="alert">
            {error || ' '}
          </p>
        )}

        <div className={styles.buttonRow}>
          <button type="button" className={styles.cancelButton} onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className={styles.submitButton} disabled={!canSubmit}>
            <span>{submitting ? 'Recovering...' : 'Recover vault'}</span>
            <ArrowRight size={16} weight="bold" />
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default UsbRecoveryModal;
