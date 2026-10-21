import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';

import wardenLogo from '../../assets/warden_logo_badge.svg';
import { useSessionToken } from '../../utils/useSessionToken.js';
import { applyTheme, getInitialTheme } from '../../utils/theme.js';
import Icon from './Icon.jsx';
import site from './site.module.css';
import styles from './SiteHeader.module.css';

const NAV_LINKS = [
  { to: '/#contact', label: 'Contact', hash: '#contact' },
];

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

function ThemeButton() {
  const [theme, setTheme] = useState(getInitialTheme);
  const next = theme === 'light' ? 'dark' : 'light';
  return (
    <button
      type="button"
      className={styles.iconButton}
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
      aria-label={`Switch to ${next} theme`}
    >
      <Icon name={theme === 'light' ? 'sun' : 'moon'} />
    </button>
  );
}

function SiteHeader() {
  const token = useSessionToken();
  const location = useLocation();
  const [scrolled, setScrolled] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef(null);
  const menuButtonRef = useRef(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const isActiveLink = (link) => location.pathname === '/' && location.hash === link.hash;

  const onSectionClick = (link) => (event) => {
    if (location.pathname !== '/' || location.hash !== link.hash) return;
    event.preventDefault();
    setDrawerOpen(false);
    const target = document.getElementById(link.hash.slice(1));
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  };

  const closeDrawer = useCallback(({ restoreFocus = true } = {}) => {
    setDrawerOpen(false);
    if (restoreFocus) requestAnimationFrame(() => menuButtonRef.current?.focus());
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname, location.hash]);

  useEffect(() => {
    if (!drawerOpen) return undefined;

    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    const drawer = drawerRef.current;
    drawer?.querySelector(FOCUSABLE)?.focus();

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDrawer();
        return;
      }
      if (event.key !== 'Tab' || !drawer) return;
      const items = [...drawer.querySelectorAll(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [drawerOpen, closeDrawer]);

  const authLinks = token ? (
    <Link to="/files" className={`${site.button} ${site.primary}`}>
      Go to vault
    </Link>
  ) : (
    <>
      <Link to="/login" className={`${site.button} ${site.ghost}`}>
        Log in
      </Link>
      <Link to="/signup" className={`${site.button} ${site.primary}`}>
        Sign up
      </Link>
    </>
  );

  return (
    <header className={`${styles.header} ${scrolled ? styles.scrolled : ''}`}>
      <div className={`${site.container} ${styles.inner}`}>
        <Link to="/" className={styles.brand} aria-label="Warden home">
          <img src={wardenLogo} alt="" width="28" height="28" className={styles.mark} />
          <span className={styles.wordmark}>Warden</span>
        </Link>

        <nav className={styles.nav} aria-label="Main">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              onClick={onSectionClick(link)}
              className={`${styles.navLink} ${isActiveLink(link) ? styles.navLinkActive : ''}`}
              aria-current={isActiveLink(link) ? 'location' : undefined}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className={styles.actions}>
          <ThemeButton />
          <div className={styles.authLinks}>{authLinks}</div>
          <button
            ref={menuButtonRef}
            type="button"
            className={`${styles.iconButton} ${styles.menuButton}`}
            onClick={() => setDrawerOpen(true)}
            aria-expanded={drawerOpen}
            aria-controls="site-drawer"
            aria-label="Open menu"
          >
            <Icon name="menu" />
          </button>
        </div>
      </div>

      {drawerOpen &&
        createPortal(
        <div className={styles.drawerLayer}>
          <div className={styles.scrim} onClick={() => closeDrawer()} aria-hidden="true" />
          <div
            ref={drawerRef}
            id="site-drawer"
            className={styles.drawer}
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
          >
            <div className={styles.drawerTop}>
              <span className={styles.wordmark}>Menu</span>
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => closeDrawer()}
                aria-label="Close menu"
              >
                <Icon name="close" />
              </button>
            </div>
            <nav aria-label="Main" className={styles.drawerNav}>
              <Link to="/" className={styles.drawerLink}>
                Home
              </Link>
              {NAV_LINKS.map((link) => (
                <Link key={link.to} to={link.to} onClick={onSectionClick(link)} className={styles.drawerLink}>
                  {link.label}
                </Link>
              ))}
              <Link to="/privacy" className={styles.drawerLink}>
                Privacy
              </Link>
              <Link to="/terms" className={styles.drawerLink}>
                Terms
              </Link>
            </nav>
            <div className={styles.drawerAuth}>{authLinks}</div>
          </div>
        </div>,
          document.body
        )}
    </header>
  );
}

export default SiteHeader;
