import { CheckSquare, List, LockKey, MagnifyingGlass } from '@phosphor-icons/react';

import wardenLogo from '../assets/warden_logo_badge.svg';
import ThemeToggle from './ThemeToggle.jsx';
import styles from './Header.module.css';

function Header({
  onLock,
  onToggleNav,
  searchTerm,
  onSearchChange,
  showSelectButton,
  onEnterSelectMode,
}) {
  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <button
          type="button"
          className={styles.navToggle}
          onClick={onToggleNav}
          aria-label="Toggle navigation"
        >
          <List size={20} weight="bold" />
        </button>

        <ThemeToggle />

        <div className={styles.brand} title="Local instance - no cloud sync">
          <img src={wardenLogo} alt="Warden" className={styles.mark} />
          <span className={styles.wordmark}>WARDEN</span>
        </div>
      </div>

      <div className={styles.searchWrap}>
        <MagnifyingGlass size={16} className={styles.searchIcon} />
        <input
          type="search"
          className={styles.searchInput}
          value={searchTerm}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search your documents"
          aria-label="Search documents"
        />
      </div>

      <div className={styles.actions}>
        {showSelectButton && (
          <button type="button" className={styles.selectButton} onClick={onEnterSelectMode}>
            <CheckSquare size={16} weight="bold" />
            <span>Select</span>
          </button>
        )}
        <button type="button" className={styles.lockButton} onClick={onLock}>
          <LockKey size={16} weight="bold" />
          <span>Lock vault</span>
        </button>
      </div>
    </header>
  );
}

export default Header;
