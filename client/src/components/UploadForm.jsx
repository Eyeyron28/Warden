import { useRef, useState } from 'react';
import { UploadSimple, X } from '@phosphor-icons/react';

import styles from './UploadForm.module.css';

function UploadForm({ onSubmit, onCancel, uploading, progress, error }) {
  const [file, setFile] = useState(null);
  const [folder, setFolder] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const fileInputRef = useRef(null);

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!file || uploading) return;
    onSubmit({ file, folder: folder.trim(), expiryDate });
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

      <div className={styles.fieldsRow}>
        <div className={styles.field}>
          <label htmlFor="upload-folder" className={styles.label}>
            Folder
          </label>
          <input
            id="upload-folder"
            type="text"
            className={styles.textInput}
            value={folder}
            onChange={(event) => setFolder(event.target.value)}
            placeholder="root"
            disabled={uploading}
          />
        </div>
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
            disabled={uploading}
          />
        </div>
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
