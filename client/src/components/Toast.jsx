import { useEffect } from 'react';
import { CheckCircle, X } from '@phosphor-icons/react';

import styles from './Toast.module.css';

const AUTO_DISMISS_MS = 4500;

/**
 * Success toasts ("Moved 3 items to Taxes"). Errors still use the page's
 * inline banner - a toast that vanishes on its own is the wrong place for
 * something the person may need to act on.
 *
 * The aria-live region is the always-mounted wrapper (ToastRegion), not
 * the toast itself: screen readers only announce changes inside a live
 * region that already existed before the content was inserted.
 */
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
