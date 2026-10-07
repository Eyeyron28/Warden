import { createContext, useContext } from 'react';

/**
 * What the signed-in app shell (header, sidebar, toasts) shares with the page
 * in its content area: the header's search text, a way to show a success
 * toast, and a way to tell the sidebar that folders or storage changed.
 */
export const ShellContext = createContext({
  searchTerm: '',
  setSearchTerm: () => {},
  showToast: () => {},
  refreshSidebar: () => {},
});

export const useShell = () => useContext(ShellContext);
