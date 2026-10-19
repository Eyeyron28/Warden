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

/**
 * The signed-in app: header on top, a persistent sidebar on the left (a
 * slide-in drawer under 768px) and the current page filling everything
 * beside it. Every page is a real route under this layout, so refresh and
 * the back button work.
 */
function AppLayout({ onLocked }) {
  const location = useLocation();
  const isDrawer = useMediaQuery('(max-width: 767px)');
  const [navOpen, setNavOpen] = useState(false);
  // Collapsed icon rail (desktop). Kept in memory only: a reload starts expanded.
  const [collapsed, setCollapsed] = useState(false);
  const [searchTerm, setSearchTermState] = useState('');
  const [sidebarVersion, setSidebarVersion] = useState(0);
  const [toast, setToast] = useState(null);

  // Search belongs to My Files only: the bar is hidden elsewhere, and a leftover term is cleared.
  const onFilesPage = location.pathname === '/files';

  // The drawer closes whenever the route (or the folder shown) changes.
  useEffect(() => {
    setNavOpen(false);
    if (location.pathname !== '/files') setSearchTermState('');
  }, [location.pathname, location.search]);

  // A resize up to the desktop layout leaves no drawer open behind it.
  useEffect(() => {
    if (!isDrawer) setNavOpen(false);
  }, [isDrawer]);

  // Search only exists on My Files (the bar is hidden elsewhere), so typing never needs to navigate.
  const setSearchTerm = setSearchTermState;

  const showToast = useCallback((message) => setToast({ id: Date.now(), message }), []);
  const refreshSidebar = useCallback(() => setSidebarVersion((version) => version + 1), []);

  // A file dropped anywhere else must never be opened by the browser: while the app is open, a drag that carries files is
  // always handled (the drop zones still take their files; everything else just ignores the drop).
  useEffect(() => {
    const guard = (event) => hasFiles(event) && event.preventDefault();
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, []);

  // A background import finished (or files moved elsewhere): the folder tree in the sidebar is read again.
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
            {/* A page's code is fetched on first visit. The boundary is HERE, inside the frame: without it the whole app
                (header and sidebar included) was hidden until that code arrived. */}
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
