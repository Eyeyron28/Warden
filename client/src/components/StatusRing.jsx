import { useRef } from 'react';

import { SealRing } from './TransferTrayView.jsx';
import styles from './TransferTray.module.css';

/**
 * A tray row's status icon that explains itself. It is a button (so the keyboard reaches it) whose accessible name is the
 * explanation. The words show in the shared tooltip (utils/tooltip.js, one implementation for every control): on mouse hover, and at
 * once on keyboard focus, through its data-tip. On a touch screen a tap shows the same words in a popover beside the icon (the same
 * floating element), and a tap anywhere else hides it.
 */
function StatusRing({ ring, percent, tip }) {
  const button = useRef(null);
  const pointer = useRef('mouse');
  return (
    <button
      ref={button}
      type="button"
      className={styles.statusButton}
      aria-label={tip}
      data-tip={tip}
      data-testid="status-icon"
      onPointerDown={(event) => {
        pointer.current = event.pointerType || 'mouse';
      }}
      onClick={() => {
        if (pointer.current === 'touch') import('../utils/tooltip.js').then((module) => module.toggleSticky(button.current, tip));
      }}
    >
      <SealRing ring={ring} percent={percent} />
    </button>
  );
}

export default StatusRing;
