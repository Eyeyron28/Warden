import { useState } from 'react';
import { Copy, Check, Warning } from '@phosphor-icons/react';

import styles from './RecoveryKeyReveal.module.css';

/**
 * Shown exactly once, right after first-run setup. The confirm button
 * stays disabled until the user checks the acknowledgement box, so this
 * can't be dismissed by an accidental click - the recovery key is never
 * retrievable again after this screen closes.
 */
function RecoveryKeyReveal({ recoveryKey, onConfirm }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied by the browser; the key is still
      // fully visible and selectable on screen, so this is a soft failure.
    }
  };

  return (
    <div className={styles.reveal}>
      <Warning size={28} weight="fill" className={styles.warningIcon} />

      <div className={styles.copy}>
        <h1 className={styles.title}>Save your recovery key</h1>
        <p className={styles.subtitle}>
          This key is the only way to recover your vault if you forget your master
          password. It is shown once, right now, and never again.
        </p>
      </div>

      <div className={styles.keyRow}>
        <code className={styles.key}>{recoveryKey}</code>
        <button type="button" className={styles.copyButton} onClick={handleCopy}>
          {copied ? <Check size={16} weight="bold" /> : <Copy size={16} weight="bold" />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>

      <label className={styles.acknowledge}>
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        <span>I've saved this recovery key somewhere safe.</span>
      </label>

      <button
        type="button"
        className={styles.continueButton}
        disabled={!acknowledged}
        onClick={onConfirm}
      >
        Continue to vault
      </button>
    </div>
  );
}

export default RecoveryKeyReveal;
