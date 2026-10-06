import { useState } from 'react';

import Icon from '../../components/site/Icon.jsx';
import site from '../../components/site/site.module.css';
import forms from '../../components/site/forms.module.css';
import styles from './auth.module.css';

/**
 * The one and only time a recovery key is shown. Copy and download are
 * both offered (a download survives a clipboard that gets overwritten),
 * and Continue stays disabled until "I have saved it" is ticked.
 */
function RecoveryKeyStep({ recoveryKey, email, onContinue, continueLabel = 'Continue' }) {
  const [saved, setSaved] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopyStatus('Copied to clipboard.');
    } catch {
      setCopyStatus('Couldn’t copy automatically - select the key and copy it by hand.');
    }
  };

  const handleDownload = () => {
    const contents = [
      'Warden recovery key',
      '',
      recoveryKey,
      '',
      email ? `Account: ${email}` : '',
      `Saved: ${new Date().toISOString().slice(0, 10)}`,
      '',
      'Keep this somewhere safe and offline. With it you can reset your password',
      'without losing your documents. Warden cannot show it to you again.',
    ]
      .filter((line, index, lines) => line || lines[index - 1])
      .join('\n');
    const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'warden-recovery-key.txt';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className={styles.stack}>
      <div className={styles.keyBox}>
        <p className={styles.keyLabel} id="recovery-key-label">
          Your recovery key
        </p>
        <p className={styles.key} aria-labelledby="recovery-key-label">
          {recoveryKey}
        </p>
        <div className={styles.keyActions}>
          <button type="button" className={`${site.button} ${site.ghost}`} onClick={handleCopy}>
            <Icon name="copy" size={18} />
            Copy
          </button>
          <button type="button" className={`${site.button} ${site.ghost}`} onClick={handleDownload}>
            <Icon name="download" size={18} />
            Download .txt
          </button>
        </div>
        <p className={forms.hint} role="status" aria-live="polite">
          {copyStatus}
        </p>
      </div>

      <div className={forms.notice}>
        <Icon name="alert" />
        <p>
          <strong>This is shown only once.</strong> If you forget your password, this key is how you get back in
          without losing your documents. Warden can&apos;t show it again or recover it for you.
        </p>
      </div>

      <label className={forms.checkboxRow}>
        <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />
        <span>I have saved my recovery key somewhere safe.</span>
      </label>

      <button
        type="button"
        className={`${site.button} ${site.primary} ${site.block}`}
        disabled={!saved}
        onClick={onContinue}
      >
        {continueLabel}
      </button>
    </div>
  );
}

export default RecoveryKeyStep;
