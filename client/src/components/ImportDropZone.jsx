import { useRef, useState } from 'react';
import { FileZip, UploadSimple } from '@phosphor-icons/react';

import styles from './ImportDropZone.module.css';

/** Only a .zip is taken (by name, or by type when the system gives one). */
export const isZipFile = (file) => /\.zip$/i.test(file?.name || '') || file?.type === 'application/zip' || file?.type === 'application/x-zip-compressed';

export const NOT_A_ZIP = (name) => `Only a .zip file can be imported. “${name}” is not one.`;

/**
 * The Import card's drop zone. It only draws what it is given (idle, drag over, chosen, invalid), so each state can be rendered on
 * its own; the page owns the zip and the import.
 *
 * props: dragOver (bool, for tests and for the zone's own hover), chosen ({ name, files, size, folders } or null), error (string),
 * disabled, onFile(file), children (the problems found in a chosen zip).
 */
export function ImportDropZone({ dragOver: forcedOver = false, chosen = null, error = '', disabled = false, onFile, children }) {
  const input = useRef(null);
  const [over, setOver] = useState(false);
  const active = (forcedOver || over) && !disabled;
  const state = error ? 'invalid' : chosen ? 'chosen' : active ? 'dragover' : 'idle';

  const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
  const take = (file) => {
    if (file) onFile?.(file);
  };

  return (
    <div
      className={styles.zone}
      data-testid="import-dropzone"
      data-state={state}
      onDragEnter={(event) => {
        if (disabled || !hasFiles(event)) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragOver={(event) => {
        if (disabled || !hasFiles(event)) return;
        event.preventDefault();
        // eslint-disable-next-line no-param-reassign
        event.dataTransfer.dropEffect = 'copy';
        if (!over) setOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOver(false);
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setOver(false);
        if (disabled) return;
        take(event.dataTransfer.files?.[0]);
      }}
    >
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip"
        className={styles.hidden}
        tabIndex={-1}
        aria-label="Choose a .zip to import"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // eslint-disable-next-line no-param-reassign
          event.target.value = '';
          take(file);
        }}
      />

      <span className={styles.icon} aria-hidden="true">
        {chosen && !error ? <FileZip size={32} weight="duotone" /> : <UploadSimple size={32} weight="duotone" />}
      </span>

      {chosen && !error ? (
        <div className={styles.chosen} role="status">
          <p className={styles.fileName} title={chosen.name}>
            {chosen.name}
          </p>
          <ul className={styles.chips} aria-label="What is in the zip">
            <li>{chosen.files === 1 ? '1 file' : `${chosen.files} files`}</li>
            <li>{chosen.size}</li>
            <li>{chosen.folders === 1 ? '1 folder' : `${chosen.folders} folders`}</li>
          </ul>
          {children}
        </div>
      ) : (
        <p className={styles.prompt}>{state === 'dragover' ? 'Drop the .zip here' : 'Drag a .zip here'}</p>
      )}

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {!disabled && (
        <button type="button" className={styles.choose} onClick={() => input.current?.click()}>
          {chosen && !error ? 'Choose another .zip…' : 'Choose a .zip…'}
        </button>
      )}
    </div>
  );
}

export default ImportDropZone;
