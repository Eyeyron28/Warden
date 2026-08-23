import { Lock, LockOpen, X } from '@phosphor-icons/react';

import styles from './VaultDial.module.css';

/**
 * Signature visual element: a mechanical vault dial rendered in SVG.
 * Its motion is tied to real unlock state (idle scan / unlocking spin-up /
 * unlocked settle / error jolt) rather than decorative animation.
 */
function VaultDial({ status = 'idle' }) {
  const ticks = Array.from({ length: 24 });

  return (
    <div className={`${styles.dial} ${styles[status]}`} aria-hidden="true">
      <svg viewBox="0 0 200 200" className={styles.svg}>
        <circle className={styles.ringOuter} cx="100" cy="100" r="92" />
        <circle className={styles.ringMid} cx="100" cy="100" r="72" />

        <g className={styles.ticks}>
          {ticks.map((_, i) => (
            <line
              key={i}
              x1="100"
              y1="10"
              x2="100"
              y2="20"
              transform={`rotate(${(360 / ticks.length) * i} 100 100)`}
            />
          ))}
        </g>

        <circle className={styles.scanArc} cx="100" cy="100" r="82" />
        <circle className={styles.core} cx="100" cy="100" r="48" />
      </svg>

      <div className={styles.iconSlot}>
        {status === 'error' ? (
          <X size={28} weight="bold" className={styles.icon} />
        ) : status === 'unlocked' ? (
          <LockOpen size={28} weight="fill" className={styles.icon} />
        ) : (
          <Lock size={26} weight="fill" className={styles.icon} />
        )}
      </div>
    </div>
  );
}

export default VaultDial;
