import { useState } from 'react';

import Modal from './Modal.jsx';
import FileNameLabel from './FileNameLabel.jsx';
import { RELEASE_WORD } from '../services/quarantineService.js';
import styles from './ReleaseDialog.module.css';

/** Whether what was typed is the confirmation word. Exact: the word in capitals (spaces around it do not count). */
export const matchesReleaseWord = (typed) => String(typed ?? '').trim() === RELEASE_WORD;

/**
 * "Release this file?": says what it matched and what releasing means, and keeps the button off until the word RELEASE is typed.
 * `initialValue` is for rendering a state on its own. Uses the shared Modal, so Esc, focus and small screens behave like every dialog.
 */
function ReleaseDialog({ item, busy = false, error = '', initialValue = '', onCancel, onConfirm }) {
  const [typed, setTyped] = useState(initialValue);
  const ready = matchesReleaseWord(typed) && !busy;

  const submit = (event) => {
    event.preventDefault();
    if (ready) onConfirm(typed.trim());
  };

  return (
    <Modal title="Release this file?" onClose={onCancel}>
      <form className={styles.form} onSubmit={submit} data-testid="release-dialog">
        <p className={styles.file}>
          <FileNameLabel name={item.name} />
        </p>
        <p className={styles.text}>It was held because:</p>
        <ul className={styles.reasons}>
          {item.reasons.map((reason) => (
            <li key={reason.code}>{reason.text}</li>
          ))}
        </ul>
        <p className={styles.warning}>
          Warden cannot tell for sure whether this file is harmful. Once released it appears in My files, and can be opened, downloaded and
          shared like any other. <strong>Only release a file you trust.</strong>
        </p>
        <label data-required className={styles.label} htmlFor="release-word">
          Type {RELEASE_WORD} to confirm
        </label>
        <input
          id="release-word"
          className={styles.input}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          aria-describedby={error ? 'release-error' : undefined}
        />
        {error && (
          <p id="release-error" className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={styles.danger} disabled={busy} aria-disabled={!ready || undefined} data-tip={ready ? 'Move this file out of quarantine' : 'Type RELEASE to enable'} data-action="confirm-release">
            {busy ? 'Releasing…' : 'Release file'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default ReleaseDialog;
