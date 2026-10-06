import { Suspense, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';

import SiteHeader from './SiteHeader.jsx';
import SiteFooter from './SiteFooter.jsx';
import styles from './PublicLayout.module.css';

function scrollToHash(hash) {
  const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
  if (!target) return false;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // scroll-margin-top (styles/global.css) keeps it clear of the sticky header.
  target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  return true;
}

/**
 * Shell for every public page: skip link, sticky header, page, footer.
 *
 * React Router doesn't scroll on navigation by itself: a new page starts
 * at the top, and a "/#section" link (e.g. from another page's footer)
 * scrolls to that section once the lazily-loaded page has rendered it.
 */
function PublicLayout() {
  const { pathname, hash } = useLocation();

  useEffect(() => {
    if (hash) {
      // The target may live in a route chunk that's still loading.
      let attempts = 0;
      const tryScroll = () => {
        if (scrollToHash(hash) || attempts > 20) return;
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
        <Suspense fallback={<div className={styles.loading} aria-busy="true" />}>
          <Outlet />
        </Suspense>
      </main>
      <SiteFooter />
    </div>
  );
}

export default PublicLayout;
