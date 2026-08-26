import { useEffect } from 'react';
import { X } from '@phosphor-icons/react';

import styles from './Modal.module.css';

/**
 * Generic overlay dialog: backdrop, Esc-to-close, click-outside-to-close.
 * Backup/restore/upload use inline panels within the page flow instead of
 * this, since those are page-level toolbar actions; this is for
 * per-row/per-item actions (like sharing a single document) where an
 * overlay reads better than pushing the whole list down.
 */
function Modal({ title, onClose, children }) {
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  );
}

export default Modal;
