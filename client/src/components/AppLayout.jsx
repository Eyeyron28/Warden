import { useCallback, useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

import Header from './Header.jsx';
import Sidebar from './Sidebar.jsx';
import ToastRegion from './Toast.jsx';
import { ShellContext } from './ShellContext.js';
import { useMediaQuery } from '../utils/useMediaQuery.js';
import styles from './AppLayout.module.css';

/**
 * The signed-in app: header on top, a persistent sidebar on the left (a
 * slide-in drawer under 768px) and the current page filling everything
 * beside it. Every page is a real route under this layout, so refresh and
 * the back button work.
 */
function AppLayout({ onLocked }) {
  const location = useLocation();
  const navigate = useNavigate();
  const isDrawer = useMediaQuery('(max-width: 767px)');
  const [navOpen, setNavOpen] = useState(false);
  const [searchTerm, setSearchTermState] = useState('');
  const [sidebarVersion, setSidebarVersion] = useState(0);
  const [toast, setToast] = useState(null);

  // The drawer closes whenever the route (or the folder shown) changes.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname, location.search]);

  // A resize up to the desktop layout leaves no drawer open behind it.
  useEffect(() => {
    if (!isDrawer) setNavOpen(false);
  }, [isDrawer]);

  const setSearchTerm = useCallback(
    (term) => {
      setSearchTermState(term);
      // Search looks through your files: typing from another page takes you there.
      if (term && !location.pathname.startsWith('/files')) navigate('/files');
    },
    [location.pathname, navigate]
  );

  const showToast = useCallback((message) => setToast({ id: Date.now(), message }), []);
  const refreshSidebar = useCallback(() => setSidebarVersion((version) => version + 1), []);

  const shell = useMemo(
    () => ({ searchTerm, setSearchTerm, showToast, refreshSidebar }),
    [searchTerm, setSearchTerm, showToast, refreshSidebar]
  );

  return (
    <ShellContext.Provider value={shell}>
      <div className={styles.shell}>
        <Header
          onLock={onLocked}
          onToggleNav={() => setNavOpen((open) => !open)}
          navOpen={navOpen}
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
        />
        <div className={styles.body}>
          <Sidebar drawer={isDrawer} open={navOpen} onClose={() => setNavOpen(false)} version={sidebarVersion} />
          <main className={styles.content}>
            <Outlet />
          </main>
        </div>
        <ToastRegion toast={toast} onDismiss={() => setToast(null)} />
      </div>
    </ShellContext.Provider>
  );
}

export default AppLayout;
