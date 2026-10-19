import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { UploadSimple, X } from '@phosphor-icons/react';

import FileNameLabel from './FileNameLabel.jsx';
import { getStorage } from '../services/documentsService.js';
import { getTodayDateInputValue } from '../utils/dateInputs.js';
import { formatBytes } from '../utils/listing.js';
import { hasFiles } from '../utils/fileDrag.js';
import { useFileDrag } from '../utils/useFileDrag.js';
import { addFiles, overflowMessage, removeItem, replaceFile, submitLabel, summarize } from '../utils/uploadSelection.js';
import { MAX_FILE_BYTES } from '../utils/transferRules.js';
import { canShrink } from '../utils/shrinkPlan.js';
import styles from './UploadForm.module.css';
import { shortName } from '../utils/ellipsis.js';

/**
 * The Upload dialog's form: choose up to 10 files (the Choose button, or drop them on the dashed zone), see each one with its size
 * and any problem, remove what you do not want, then "Encrypt & upload". Files with a problem stay in the list with the reason and
 * are skipped. One expiry date applies to the whole batch. Nothing is sent from here: `onSubmit({ files, expiryDate })` hands the
 * valid files over, and the page gives them to the transfer tray and closes the dialog.
 *
 * Pressing the button locks the form in the same instant (a ref, before any await), so Enter twice or a double click send ONE batch.
 * `initialFiles`, `initialUsage` and `initialOverflow` exist so each state can be rendered on its own.
 */
function UploadForm({ onSubmit, onCancel, onOpenImport, error, destinationLabel, footerEl = null, initialFiles = [], initialUsage = null, initialOverflow = 0 }) {
  const [items, setItems] = useState(() => addFiles([], initialFiles).items);
  const [overflow, setOverflow] = useState(initialOverflow);
  const [usage, setUsage] = useState(initialUsage);
  const [expiryDate, setExpiryDate] = useState('');
  const [locked, setLocked] = useState(false);
  const { active: dragOver, reset: clearDrag, handlers: dragHandlers } = useFileDrag(hasFiles);
  const [announce, setAnnounce] = useState('');
  // "Make it smaller" per row: { status: 'working' } | { status: 'ready', result } | { status: 'failed', message }
  const [shrink, setShrink] = useState({});
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const chooseRef = useRef(null);
  const lock = useRef(false);

  // The room left in the account, asked once when the dialog opens (the page checks again on submit, and the server again).
  useEffect(() => {
    let live = true;
    getStorage().then((data) => live && setUsage(data), () => {});
    return () => {
      live = false;
    };
  }, []);

  const summary = summarize(items, usage);
  const limitMessage = overflowMessage(overflow);

  const take = (files) => {
    if (lock.current || files.length === 0) return;
    const result = addFiles(items, files);
    setItems(result.items);
    setOverflow(result.overflow);
    const parts = [];
    if (result.added) parts.push(`${result.added} ${result.added === 1 ? 'file' : 'files'} added.`);
    if (result.duplicates) parts.push(`${result.duplicates} already added.`);
    if (result.overflow) parts.push(overflowMessage(result.overflow));
    setAnnounce(parts.join(' '));
  };

  const remove = (row, index) => {
    if (lock.current) return;
    setItems((current) => removeItem(current, row.id));
    setOverflow(0);
    setAnnounce(`${row.file.name} removed.`);
    // Keep the place: focus goes to the next row's remove button, or the previous one, or the Choose button. Never anywhere new.
    requestAnimationFrame(() => {
      const buttons = listRef.current?.querySelectorAll('[data-remove]');
      (buttons?.[index] || buttons?.[index - 1] || chooseRef.current)?.focus?.();
    });
  };

  const clearShrink = (id) => setShrink((current) => {
    const { [id]: dropped, ...rest } = current;
    return dropped ? rest : current;
  });

  // The photo is re-encoded in this tab (the code loads only now). Nothing replaces the original until the person agrees.
  const startShrink = async (row) => {
    setShrink((current) => ({ ...current, [row.id]: { status: 'working' } }));
    let outcome;
    try {
      const { shrinkToJpeg } = await import('../utils/shrinkImage.js');
      outcome = await shrinkToJpeg(row.file, MAX_FILE_BYTES);
    } catch {
      outcome = { ok: false, message: 'Could not make this image smaller.' };
    }
    setShrink((current) => {
      if (current[row.id]?.status !== 'working') return current; // cancelled meanwhile
      return { ...current, [row.id]: outcome.ok ? { status: 'ready', result: outcome, before: row.file.size } : { status: 'failed', message: outcome.message } };
    });
  };

  const applySmaller = (row) => {
    const result = shrink[row.id]?.result;
    if (!result || lock.current) return;
    setItems((current) => replaceFile(current, row.id, result.file));
    clearShrink(row.id);
    setAnnounce(`${row.file.name} replaced by a smaller version.`);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!summary.canUpload || lock.current) return;
    lock.current = true; // synchronous: a second event in the same tick finds it set
    setLocked(true);
    try {
      await onSubmit({ files: summary.valid.map((row) => row.file), expiryDate });
    } finally {
      lock.current = false;
      setLocked(false);
    }
  };

  const buttons = (
    <>
      <button type="button" className={styles.cancelButton} onClick={onCancel}>
        <X size={16} />
        <span>Cancel</span>
      </button>
      {/* aria-disabled (not disabled) while there is nothing to send, so the reason can show on hover; handleSubmit refuses it too. */}
      <button
        type="submit"
        form="upload-form"
        className={styles.submitButton}
        disabled={locked}
        aria-disabled={!summary.canUpload || undefined}
        data-tip={summary.canUpload ? 'Encrypt the files and save them to your vault' : 'Choose at least one file'}
      >
        {locked ? 'Sending to the tray…' : submitLabel(summary.valid.length)}
      </button>
    </>
  );


  return (
    <form id="upload-form" className={styles.form} onSubmit={handleSubmit} aria-busy={locked}>
      <div
        className={`${styles.zone} ${dragOver ? styles.zoneOver : ''}`}
        data-testid="upload-zone"
        data-over={dragOver || undefined}
        onDragEnter={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.stopPropagation();
          dragHandlers.onDragEnter(event);
        }}
        onDragOver={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.stopPropagation();
          // eslint-disable-next-line no-param-reassign
          event.dataTransfer.dropEffect = 'copy';
          dragHandlers.onDragOver(event);
        }}
        onDragLeave={dragHandlers.onDragLeave}
        onDrop={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          // The Files page behind the dialog also takes dropped files: this drop belongs to the dialog alone (one copy, not two).
          event.stopPropagation();
          clearDrag();
          take(Array.from(event.dataTransfer.files));
        }}
      >
        <button ref={chooseRef} type="button" className={styles.fileButton} onClick={() => inputRef.current?.click()} disabled={locked}>
          <UploadSimple size={16} weight="bold" className={styles.fileIcon} />
          <span>{items.length === 0 ? 'Choose files' : 'Choose more'}</span>
        </button>
        <span className={styles.zoneHint}>{items.length === 0 ? 'or drop them here' : summary.canAddMore ? 'or drop more here' : 'The limit is reached'}</span>
        <input
          ref={inputRef}
          type="file"
          multiple
          className={styles.hiddenInput}
          onChange={(event) => {
            take(Array.from(event.target.files || []));
            // eslint-disable-next-line no-param-reassign
            event.target.value = ''; // the same file can be chosen again after it was removed
          }}
          disabled={locked}
          tabIndex={-1}
          aria-hidden="true"
        />
      </div>

      {limitMessage && (
        <p className={styles.limitMessage} data-testid="upload-limit-message">
          {limitMessage}
        </p>
      )}

      {items.length > 0 && (
        <>
          <p className={styles.counter} data-testid="upload-counter">
            {summary.counter}
          </p>
          <ul className={styles.rows} ref={listRef} aria-label="Files to upload" data-testid="upload-rows">
            {items.map((row, index) => (
              <li
                key={row.id}
                className={`${styles.row} ${row.error ? styles.rowError : ''}`}
                data-testid="upload-row"
                data-error={row.error ? 'true' : undefined}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.target === event.currentTarget && (event.key === 'Delete' || event.key === 'Backspace')) {
                    event.preventDefault();
                    remove(row, index);
                  }
                }}
              >
                <span className={styles.rowName}>
                  <FileNameLabel name={row.file.name} />
                </span>
                <span className={styles.rowSize}>{formatBytes(row.file.size)}</span>
                {row.error && <span className={styles.rowReason}>{row.error}</span>}
                {row.file.size > MAX_FILE_BYTES && !row.zip && (
                  <div className={styles.shrinkBox}>
                    {!canShrink(row.file, MAX_FILE_BYTES) && <span className={styles.shrinkNote}>This file type does not shrink much. The limit is 4 MB.</span>}
                    {canShrink(row.file, MAX_FILE_BYTES) && !shrink[row.id] && (
                      <button type="button" className={styles.shrinkButton} onClick={() => startShrink(row)} disabled={locked}>
                        Make it smaller
                      </button>
                    )}
                    {shrink[row.id]?.status === 'working' && (
                      <>
                        <span className={styles.shrinkNote}>Making it smaller…</span>
                        <button type="button" className={styles.shrinkButton} onClick={() => clearShrink(row.id)}>
                          Cancel
                        </button>
                      </>
                    )}
                    {shrink[row.id]?.status === 'failed' && <span className={styles.shrinkNote}>{shrink[row.id].message}</span>}
                    {shrink[row.id]?.status === 'ready' && (
                      <>
                        <span className={styles.shrinkNote}>
                          {formatBytes(shrink[row.id].before)} to {formatBytes(shrink[row.id].result.file.size)}, saved as JPEG, lower quality. Re-encoding drops camera metadata (EXIF, location).
                        </span>
                        <span className={styles.shrinkActions}>
                          <button type="button" className={styles.shrinkButton} onClick={() => applySmaller(row)}>
                            Use smaller version
                          </button>
                          <button type="button" className={styles.shrinkButton} onClick={() => clearShrink(row.id)}>
                            Cancel
                          </button>
                        </span>
                      </>
                    )}
                  </div>
                )}
                {row.zip && onOpenImport && (
                  <button type="button" className={styles.openImport} data-action="open-import" onClick={onOpenImport}>
                    Open Export / Import
                  </button>
                )}
                <button type="button" className={styles.remove} data-remove="true" onClick={() => remove(row, index)} disabled={locked} aria-label={`Remove ${shortName(row.file.name)}`}>
                  <X size={14} weight="bold" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {summary.quotaMessage && (
        <p className={styles.error} role="alert" data-testid="upload-quota-message">
          {summary.quotaMessage}
        </p>
      )}

      {destinationLabel && <p className={styles.destination}>Uploading to: {destinationLabel}</p>}

      <div className={styles.field}>
        <label htmlFor="upload-expiry" className={styles.label}>
          Expiry date for all files (optional)
        </label>
        <input id="upload-expiry" type="date" className={styles.textInput} value={expiryDate} onChange={(event) => setExpiryDate(event.target.value)} min={getTodayDateInputValue()} disabled={locked} />
      </div>

      <div className={styles.visuallyHidden} role="status" aria-live="polite">
        {announce}
      </div>

      <p className={styles.error} role="alert">
        {error || ' '}
      </p>

      {/* The buttons live in the dialog's own footer (fixed under the scrolling body) when the page gives one; the submit button
          still belongs to this form (form="upload-form"). Without one (a render on its own) they sit at the end of the form. */}
      {footerEl ? createPortal(buttons, footerEl) : <div className={styles.buttonRow}>{buttons}</div>}
    </form>
  );
}

export default UploadForm;
