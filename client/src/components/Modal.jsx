import { useEffect, useRef } from 'react';
import { X } from '@phosphor-icons/react';

import { useFocusTrap } from '../utils/useFocusTrap.js';
import styles from './Modal.module.css';

/**
 * Generic overlay dialog: backdrop, Esc-to-close, click-outside-to-close.
 * Used for every page-level action (upload, pairing,
 * paired devices) and per-item ones (sharing) so nothing ever pushes the
 * document list down or renders inline in the page body.
 */
function Modal({ title, onClose, children }) {
  const dialogRef = useRef(null);
  // Focus moves in, Tab stays inside, and focus returns to what opened it.
  useFocusTrap(dialogRef, true);

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
        ref={dialogRef}
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
