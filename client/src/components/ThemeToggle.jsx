import { useState } from 'react';
import { Moon, Sun } from '@phosphor-icons/react';

import { applyTheme, getInitialTheme } from '../utils/theme.js';
import styles from './ThemeToggle.module.css';

function ThemeToggle() {
  const [theme, setTheme] = useState(getInitialTheme);

  const handleToggle = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    setTheme(next);
  };

  return (
    <button
      type="button"
      className={styles.button}
      onClick={handleToggle}
      aria-label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
      title={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
    >
      {theme === 'light' ? <Sun size={18} weight="bold" /> : <Moon size={18} weight="bold" />}
    </button>
  );
}

export default ThemeToggle;
