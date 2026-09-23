import { useState } from 'react';
import { Moon, Sun } from '@phosphor-icons/react';

import { applyTheme, getInitialTheme } from '../utils/theme.js';
import styles from './ThemeToggle.module.css';

/**
 * Sun/moon icon button - shows the CURRENTLY active theme (sun while
 * light, moon while dark), same convention as most OS-level toggles.
 * getInitialTheme() reads back whatever index.html's blocking inline
 * script already decided (stored choice, else system preference), so
 * this never has to re-derive it or risk disagreeing on first render.
 */
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
