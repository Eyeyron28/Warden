import { useEffect, useRef } from 'react';
import { X } from '@phosphor-icons/react';

import { splitNamedTitle } from '../utils/namedTitle.js';
import { useFocusTrap } from '../utils/useFocusTrap.js';
import styles from './Modal.module.css';

function Title({ title }) {
  const named = splitNamedTitle(title);
  return (
    <h2 className={styles.title} title={title}>
      {named ? (
        <>
          {named.before}
          <span className={styles.titleName}>{named.name}</span>
          {named.after}
        </>
      ) : (
        title
      )}
    </h2>
  );
}

function Modal({ title, onClose, children, footer = null, wide = false, size = 'default' }) {
  const dialogRef = useRef(null);
  useFocusTrap(dialogRef, true);

  useEffect(() => {
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = before;
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const kind = wide ? 'wide' : size;
  return (
    <div className={`${styles.backdrop} ${kind === 'share' ? styles.backdropShare : ''}`} onClick={onClose}>
      <div
        ref={dialogRef}
        className={`${styles.dialog} ${kind === 'wide' ? styles.wide : ''} ${kind === 'share' ? styles.share : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.header}>
          <Title title={title} />
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>
  );
}

export default Modal;
