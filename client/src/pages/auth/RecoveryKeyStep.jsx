import { useEffect, useRef, useState } from 'react';

import Icon from '../../components/site/Icon.jsx';
import { COPY_FEEDBACK_MS, keyDownloadText, keyForCopy, keyGroups, keySheet, keySpoken } from '../../utils/recoveryKey.js';
import site from '../../components/site/site.module.css';
import forms from '../../components/site/forms.module.css';
import styles from './auth.module.css';

/**
 * The one and only time a recovery key is shown (after sign-up, and after a "start over" reset).
 *
 * The key is drawn as equal-width chips in a grid (four across, or a 2x2 block on a phone) with a separator between groups
 * only. Copying - the button, or selecting and copying by hand - always gives the key in its normal dashed form on one line.
 * Copy, Download and Print are offered, and Continue stays disabled until "I have saved it" is ticked.
 *
 * The key exists only in this component's props: it is never written to localStorage, sessionStorage, IndexedDB, a cookie,
 * the URL or a log, it is not in a form field (so password managers and autofill leave it alone), and the parent drops it
 * when the screen is left.
 */
function RecoveryKeyStep({ recoveryKey, email, onContinue, continueLabel = 'Continue' }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const groups = keyGroups(recoveryKey);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(keyForCopy(recoveryKey));
      setCopyFailed(false);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      setCopyFailed(true);
    }
  };

  // Selecting the chips and pressing copy gives the dashed one-line key, not the chips' separate boxes.
  const handleSelectionCopy = (event) => {
    event.clipboardData.setData('text/plain', keyForCopy(recoveryKey));
    event.preventDefault();
  };

  const handleDownload = () => {
    const url = URL.createObjectURL(new Blob([keyDownloadText({ key: recoveryKey, email })], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'warden-recovery-key.txt';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const sheet = keySheet({ key: recoveryKey, email });

  return (
    <div className={styles.stack}>
      <div className={styles.keyBox}>
        <p className={styles.keyLabel} id="recovery-key-label">
          Your recovery key
        </p>
        {/* One labelled string for a screen reader; the chips are only paint. Not an input, so autofill and password managers skip it. */}
        <div
          className={styles.keyChips}
          role="img"
          aria-label={keySpoken(recoveryKey)}
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
          data-form-type="other"
          onCopy={handleSelectionCopy}
        >
          {groups.map((group, index) => (
            <span key={index} className={styles.keyChip} aria-hidden="true">
              {group}
            </span>
          ))}
        </div>
        <div className={styles.keyActions}>
          <button type="button" className={`${site.button} ${site.ghost}`} onClick={handleCopy}>
            <Icon name={copied ? 'check' : 'copy'} size={18} />
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" className={`${site.button} ${site.ghost}`} onClick={handleDownload}>
            <Icon name="download" size={18} />
            Download .txt
          </button>
          <button type="button" className={`${site.button} ${site.ghost}`} onClick={() => window.print()}>
            <Icon name="print" size={18} />
            Print
          </button>
        </div>
        <p className={`${forms.hint} ${styles.copyStatus}`} role="status" aria-live="polite">
          {copied ? 'Copied to the clipboard.' : copyFailed ? 'Couldn’t copy automatically. Select the key and copy it by hand.' : ''}
        </p>
      </div>

      <div className={forms.notice}>
        <Icon name="alert" />
        <p>
          <strong>This is shown only once.</strong> If you forget your password, this key is the only way back in without
          losing your documents.
        </p>
      </div>

      <label className={forms.checkboxRow}>
        <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />
        <span>I have saved my recovery key.</span>
      </label>

      <button type="button" className={`${site.button} ${site.primary} ${site.block}`} disabled={!saved} onClick={onContinue}>
        {continueLabel}
      </button>

      {/* Only what is printed: hidden on screen, the only thing visible in the print preview. */}
      <section className={styles.printSheet} aria-hidden="true">
        <h2>{sheet.title}</h2>
        <p className={styles.printKey}>{sheet.key}</p>
        {sheet.email && <p>Email: {sheet.email}</p>}
        <p>Date: {sheet.date}</p>
        <p>{sheet.note}</p>
      </section>
    </div>
  );
}

export default RecoveryKeyStep;
