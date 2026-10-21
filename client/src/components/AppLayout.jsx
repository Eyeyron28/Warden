import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';

import Header from './Header.jsx';
import Sidebar from './Sidebar.jsx';
import EmergencyBanner from './EmergencyBanner.jsx';
import ToastRegion from './Toast.jsx';
import { PageSkeleton } from './Skeletons.jsx';
import RouteErrorBoundary from './RouteErrorBoundary.jsx';
import { ShellContext } from './ShellContext.js';
import { DOCUMENTS_CHANGED } from '../utils/dragMove.js';
import { hasFiles } from '../utils/fileDrag.js';
import { useMediaQuery } from '../utils/useMediaQuery.js';
import styles from './AppLayout.module.css';

function AppLayout({ onLocked }) {
  const location = useLocation();
  const isDrawer = useMediaQuery('(max-width: 767px)');
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [searchTerm, setSearchTermState] = useState('');
  const [sidebarVersion, setSidebarVersion] = useState(0);
  const [toast, setToast] = useState(null);

  const onFilesPage = location.pathname === '/files';

  useEffect(() => {
    setNavOpen(false);
    if (location.pathname !== '/files') setSearchTermState('');
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (!isDrawer) setNavOpen(false);
  }, [isDrawer]);

  const setSearchTerm = setSearchTermState;

  const showToast = useCallback((message) => setToast({ id: Date.now(), message }), []);
  const refreshSidebar = useCallback(() => setSidebarVersion((version) => version + 1), []);

  useEffect(() => {
    const guard = (event) => hasFiles(event) && event.preventDefault();
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, []);

  useEffect(() => {
    window.addEventListener(DOCUMENTS_CHANGED, refreshSidebar);
    return () => window.removeEventListener(DOCUMENTS_CHANGED, refreshSidebar);
  }, [refreshSidebar]);

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
          showSearch={onFilesPage}
        />
        <EmergencyBanner />
        <div className={styles.body}>
          <Sidebar
            drawer={isDrawer}
            open={navOpen}
            onClose={() => setNavOpen(false)}
            version={sidebarVersion}
            collapsed={collapsed}
            onToggleCollapsed={() => setCollapsed((value) => !value)}
          />
          <main className={styles.content}>
            <RouteErrorBoundary resetKey={location.pathname}>
              <Suspense fallback={<PageSkeleton />}>
                <Outlet />
              </Suspense>
            </RouteErrorBoundary>
          </main>
        </div>
        <ToastRegion toast={toast} onDismiss={() => setToast(null)} />
      </div>
    </ShellContext.Provider>
  );
}

export default AppLayout;
