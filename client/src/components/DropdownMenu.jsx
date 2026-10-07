import { useCallback, useRef, useState } from 'react';

import MenuPanel from './MenuPanel.jsx';
import { placeBelow } from '../utils/menuPosition.js';
import styles from './DropdownMenu.module.css';

/**
 * Trigger + panel dropdown. The panel is a MenuPanel: portal, fixed position
 * and collision handling (flips above a button near the bottom, is pulled back
 * inside near either side), so it can never overflow the screen. Trigger and
 * option list are render props so callers control what they look like.
 * Options should be `<button role="menuitem">`.
 */
function DropdownMenu({ trigger, children, align = 'left', label }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  const close = useCallback(() => setOpen(false), []);
  const placement = useCallback(
    (size, viewport) => {
      const rect = rootRef.current?.getBoundingClientRect() ?? { left: 0, right: 0, top: 0, bottom: 0 };
      return placeBelow(rect, size, viewport, { align: align === 'right' ? 'end' : 'start' });
    },
    [align]
  );

  return (
    <div className={styles.root} ref={rootRef}>
      {trigger({ open, toggle: () => setOpen((prev) => !prev), close })}
      {open && (
        <MenuPanel placement={placement} onClose={close} returnFocus={rootRef.current?.querySelector('button')} label={label}>
          {({ close: closeAndRestore }) => children({ close: closeAndRestore })}
        </MenuPanel>
      )}
    </div>
  );
}

export default DropdownMenu;
