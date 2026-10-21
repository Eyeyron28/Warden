import { useEffect } from 'react';
import { CheckCircle, X } from '@phosphor-icons/react';

import styles from './Toast.module.css';

const AUTO_DISMISS_MS = 4500;

export function ToastRegion({ toast, onDismiss }) {
  return (
    <div className={styles.region} role="status" aria-live="polite">
      {toast && <Toast key={toast.id} message={toast.message} onDismiss={onDismiss} />}
    </div>
  );
}

function Toast({ message, onDismiss }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className={styles.toast}>
      <CheckCircle size={18} weight="fill" className={styles.icon} aria-hidden="true" />
      <span className={styles.message}>{message}</span>
      <button type="button" className={styles.dismiss} onClick={onDismiss} aria-label="Dismiss notification">
        <X size={14} weight="bold" />
      </button>
    </div>
  );
}

export default ToastRegion;
