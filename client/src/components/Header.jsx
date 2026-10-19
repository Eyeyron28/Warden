import { List, SignOut, MagnifyingGlass } from '@phosphor-icons/react';

import wardenLogo from '../assets/warden_logo_badge.svg';
import ThemeToggle from './ThemeToggle.jsx';
import styles from './Header.module.css';

function Header({ onLock, onToggleNav, navOpen = false, searchTerm, onSearchChange, showSearch = true }) {
  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <button
          type="button"
          className={styles.navToggle}
          onClick={onToggleNav}
          aria-label="Open navigation menu"
          aria-expanded={navOpen}
          aria-controls="app-sidebar"
        >
          <List size={20} weight="bold" />
        </button>

        <div className={styles.brand}>
          <img src={wardenLogo} alt="Warden" className={styles.mark} />
          <span className={styles.wordmark}>WARDEN</span>
        </div>
      </div>

      {showSearch && (
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
      )}

      <div className={styles.actions}>
        <ThemeToggle />
        <button type="button" className={styles.lockButton} onClick={onLock} aria-label="Log out" data-tip="Sign out on this device">
          <SignOut size={16} weight="bold" />
          <span>Log out</span>
        </button>
      </div>
    </header>
  );
}

export default Header;
