import { Suspense, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';

import SiteHeader from './SiteHeader.jsx';
import SiteFooter from './SiteFooter.jsx';
import RouteErrorBoundary from '../RouteErrorBoundary.jsx';
import styles from './PublicLayout.module.css';

const AUTH_PATHS = new Set(['/login', '/signup', '/forgot-password', '/reset-password', '/verify-email']);

function scrollToHash(hash) {
  let id = '';
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return false;
  }
  const target = id ? document.getElementById(id) : null;
  if (!target) return false;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  return true;
}

function PublicLayout() {
  const { pathname, hash } = useLocation();

  useEffect(() => {
    if (hash) {
      let attempts = 0;
      const tryScroll = () => {
        if (scrollToHash(hash) || attempts > 120) return;
        attempts += 1;
        setTimeout(tryScroll, 50);
      };
      tryScroll();
    } else {
      window.scrollTo(0, 0);
    }
  }, [pathname, hash]);

  return (
    <div className={styles.page}>
      <a href="#main" className={styles.skipLink}>
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" tabIndex={-1} className={styles.main}>
        <RouteErrorBoundary resetKey={pathname}>
          <Suspense fallback={<div className={styles.loading} aria-busy="true" />}>
            <Outlet />
          </Suspense>
        </RouteErrorBoundary>
      </main>
      <SiteFooter compact={AUTH_PATHS.has(pathname)} />
    </div>
  );
}

export default PublicLayout;
