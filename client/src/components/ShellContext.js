import { createContext, useContext } from 'react';

export const ShellContext = createContext({
  searchTerm: '',
  setSearchTerm: () => {},
  showToast: () => {},
  refreshSidebar: () => {},
});

export const useShell = () => useContext(ShellContext);
