import { LockKey } from '@phosphor-icons/react';

import wardenLogo from '../assets/warden_logo_badge.svg';
import styles from './Header.module.css';

function Header({ onLock }) {
  return (
    <header className={styles.header}>
      <div className={styles.brand} title="Local instance - no cloud sync">
        <img src={wardenLogo} alt="Warden" className={styles.mark} />
        <span className={styles.wordmark}>WARDEN</span>
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.lockButton} onClick={onLock}>
          <LockKey size={16} weight="bold" />
          <span>Lock vault</span>
        </button>
      </div>
    </header>
  );
}

export default Header;
