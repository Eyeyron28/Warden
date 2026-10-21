import { useRef } from 'react';

import { SealRing } from './TransferTrayView.jsx';
import styles from './TransferTray.module.css';

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
