export const THEME_STORAGE_KEY = 'warden-theme';

const THEME_COLOR_META = { dark: '#130C11', light: '#F6F2F4' };

export function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function getStoredTheme() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

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
  }
}
