import { useEffect, useRef } from 'react';
import { X } from '@phosphor-icons/react';

import FileNameLabel from './FileNameLabel.jsx';
import { splitNamedTitle } from '../utils/namedTitle.js';
import { useFocusTrap } from '../utils/useFocusTrap.js';
import styles from './Modal.module.css';

function Title({ title }) {
  const named = splitNamedTitle(title);
  if (!named) {
    return (
      <h2 className={styles.title} title={title}>
        {title}
      </h2>
    );
  }
  const { before, name, after } = named;
  return (
    <h2 className={`${styles.title} ${styles.namedTitle}`} title={title}>
      <span className={styles.titleText}>{before}</span>
      <FileNameLabel name={name} className={styles.titleName} />
      <span className={styles.titleText}>{after}</span>
    </h2>
  );
}

/**
 * The one dialog every page-level action uses, so no dialog can be wider than the screen or lose its buttons:
 *   - a FIXED header (the title on one line; a quoted file name in it is cut in the middle, the full name is the tooltip),
 *   - a body that scrolls on its own, never sideways, and whose children may shrink (min-width: 0) and wrap long words,
 *   - an optional `footer` that stays visible under the scrolling body.
 * `size`: 'default' (440 px), 'wide' (760 px; the old `wide` flag) or 'share' (the landscape Share dialog).
 * Esc and a click outside close it; focus moves in, stays inside, and returns to what opened it.
 */
function Modal({ title, onClose, children, footer = null, wide = false, size = 'default' }) {
  const dialogRef = useRef(null);
  useFocusTrap(dialogRef, true);

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
