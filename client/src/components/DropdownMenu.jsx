import { useEffect, useRef, useState } from 'react';

import styles from './DropdownMenu.module.css';

/**
 * Shared trigger+panel dropdown shell - click-outside and Escape both
 * close it. Used by NewMenu and SyncMenu, which are otherwise identical
 * in behavior and differ only in what they render as the trigger and
 * the option list, hence the render-prop shape rather than two separate
 * copies of this open/close wiring.
 */
function DropdownMenu({ trigger, children, align = 'left' }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const handleClickOutside = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div className={styles.root} ref={rootRef}>
      {trigger({ open, toggle: () => setOpen((prev) => !prev), close })}
      {open && (
        <div className={`${styles.panel} ${align === 'right' ? styles.alignRight : ''}`} role="menu">
          {children({ close })}
        </div>
      )}
    </div>
  );
}

export default DropdownMenu;
