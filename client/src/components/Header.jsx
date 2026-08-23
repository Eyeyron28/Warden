import { LockKey } from '@phosphor-icons/react';

import StatusBadge from './StatusBadge.jsx';
import styles from './Header.module.css';

function Header({ onLock }) {
  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <span className={styles.mark}>W</span>
        <span className={styles.wordmark}>WARDEN</span>
      </div>

      <div className={styles.actions}>
        <StatusBadge label="Unlocked" tone="accent" dot />
        <span className={styles.secondaryBadge}>
          <StatusBadge label="Local instance" />
        </span>
        <button type="button" className={styles.lockButton} onClick={onLock}>
          <LockKey size={16} weight="bold" />
          <span>Lock vault</span>
        </button>
      </div>
    </header>
  );
}

export default Header;
