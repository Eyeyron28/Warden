export const THEME_STORAGE_KEY = 'warden-theme';

// Mirrors --color-bg's value for each theme in tokens.css by hand - a
// <meta name="theme-color"> tag (the mobile browser-chrome tint) can't
// reference a CSS custom property, so this hardcoded pair is the one
// color value in the app that has to be kept in sync manually rather
// than reading a token. Also duplicated in index.html's blocking inline
// script, which sets this same tag before React ever mounts.
const THEME_COLOR_META = { dark: '#130C11', light: '#F6F2F4' };

export function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function getStoredTheme() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // Privacy mode / storage disabled - fall through to no saved choice.
    return null;
  }
}

/**
 * index.html has a small blocking inline script that runs before React
 * mounts (avoiding a flash of the wrong theme) and already sets
 * document.documentElement.dataset.theme using this exact same
 * stored-choice-or-system-preference logic. This reads that back rather
 * than re-deciding, so the two paths can never disagree.
 */
export function getInitialTheme() {
  return document.documentElement.dataset.theme || getStoredTheme() || getSystemTheme();
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR_META[theme]);

  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Theme still applies for this page load via the DOM attribute above -
    // it just won't persist across a reload without storage access.
  }
}
