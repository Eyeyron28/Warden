// The Grid/List choice and the sort order, remembered for as long as the page
// stays open and NOT afterwards: plain module state, deliberately not
// localStorage or any other browser storage.
const prefs = { view: 'list', sort: 'newest' };

export const getViewPrefs = () => ({ ...prefs });

export function setViewPref(key, value) {
  if (key === 'view' && (value === 'list' || value === 'grid')) prefs.view = value;
  if (key === 'sort' && typeof value === 'string') prefs.sort = value;
}
