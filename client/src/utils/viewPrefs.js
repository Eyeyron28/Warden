const prefs = { view: 'list', sort: 'newest' };

export const getViewPrefs = () => ({ ...prefs });

export function setViewPref(key, value) {
  if (key === 'view' && (value === 'list' || value === 'grid')) prefs.view = value;
  if (key === 'sort' && typeof value === 'string') prefs.sort = value;
}
