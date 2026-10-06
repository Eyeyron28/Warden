import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { SECTIONS as PRIVACY_SECTIONS } from '../../pages/public/PrivacyPage.jsx';
import { SECTIONS as TERMS_SECTIONS } from '../../pages/public/TermsPage.jsx';
import Icon from './Icon.jsx';
import site from './site.module.css';
import styles from './LegalModal.module.css';

// Draft, not legal advice - the text shown here is the same draft as the
// /terms and /privacy pages.

const DOCUMENTS = {
  terms: { label: 'Terms of use', sections: TERMS_SECTIONS },
  privacy: { label: 'Privacy policy', sections: PRIVACY_SECTIONS },
};
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';
const END_TOLERANCE_PX = 24;

/**
 * The Terms of use and Privacy policy, in a dialog on top of the signup
 * form instead of a separate page, so nobody loses what they typed.
 * "Read" means scrolled to the end of that document (or it fits without
 * scrolling) - the signup form keeps its agreement checkbox disabled until
 * both are read. Traps focus, closes on Escape or Back, locks page scroll.
 *
 * Links inside the legal text point at the standalone pages; here they
 * would navigate away from the form, so they switch tabs (or open in a new
 * tab) instead.
 */
function LegalModal({ tab, onTabChange, read, onRead, onClose }) {
  const dialogRef = useRef(null);
  const scrollRef = useRef(null);

  const checkReachedEnd = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (node.scrollTop + node.clientHeight >= node.scrollHeight - END_TOLERANCE_PX) onRead(tab);
  }, [onRead, tab]);

  // New tab: back to the top, and a short document that needs no scrolling
  // counts as read straight away.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    const frame = requestAnimationFrame(checkReachedEnd);
    return () => cancelAnimationFrame(frame);
  }, [tab, checkReachedEnd]);

  useEffect(() => {
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    const dialog = dialogRef.current;
    dialog?.querySelector(FOCUSABLE)?.focus();

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const items = [...dialog.querySelectorAll(FOCUSABLE)];
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
  }, [onClose]);

  const handleContentClick = (event) => {
    const link = event.target.closest?.('a[href]');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href || href.startsWith('mailto:')) return;
    // Capture phase + stopPropagation: the legal text's links are React Router
    // <Link>s, whose own click handler would otherwise navigate away first.
    event.preventDefault();
    event.stopPropagation();
    if (href.startsWith('/privacy')) onTabChange('privacy');
    else if (href.startsWith('/terms')) onTabChange('terms');
    else window.open(href, '_blank', 'noopener');
  };

  const handleTabKeyDown = (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = tab === 'terms' ? 'privacy' : 'terms';
    onTabChange(next);
    requestAnimationFrame(() => dialogRef.current?.querySelector(`#legal-tab-${next}`)?.focus());
  };

  const bothRead = read.terms && read.privacy;
  const { sections } = DOCUMENTS[tab];

  return createPortal(
    <div className={styles.backdrop} onClick={onClose}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="legal-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.header}>
          <button type="button" className={`${site.button} ${site.ghost} ${styles.back}`} onClick={onClose}>
            <Icon name="arrowLeft" size={18} />
            Back
          </button>
          <h2 id="legal-modal-title" className={styles.title}>
            Terms and privacy
          </h2>
        </div>

        <div className={styles.tabs} role="tablist" aria-label="Document" onKeyDown={handleTabKeyDown}>
          {Object.entries(DOCUMENTS).map(([key, doc]) => (
            <button
              key={key}
              id={`legal-tab-${key}`}
              type="button"
              role="tab"
              aria-selected={tab === key}
              aria-controls="legal-panel"
              tabIndex={tab === key ? 0 : -1}
              className={`${styles.tab} ${tab === key ? styles.tabActive : ''}`}
              onClick={() => onTabChange(key)}
            >
              {doc.label}
              {read[key] && (
                <span className={styles.readMark}>
                  <Icon name="check" size={14} />
                  <span className={styles.srOnly}>(read)</span>
                </span>
              )}
            </button>
          ))}
        </div>

        <div
          id="legal-panel"
          ref={scrollRef}
          className={`${site.prose} ${styles.content}`}
          role="tabpanel"
          aria-labelledby={`legal-tab-${tab}`}
          tabIndex={0}
          onScroll={checkReachedEnd}
          onClickCapture={handleContentClick}
        >
          <p className={styles.draftNote}>
            Warden is an academic project, provided as-is. This is a plain-language draft, not a reviewed legal
            document.
          </p>
          {sections.map((section) => (
            <section key={section.id} aria-labelledby={`legal-${tab}-${section.id}`}>
              <h3 id={`legal-${tab}-${section.id}`}>{section.title}</h3>
              {section.content}
            </section>
          ))}
        </div>

        <div className={styles.footer}>
          <p className={styles.status} role="status" aria-live="polite">
            {bothRead
              ? 'You have read both. You can now tick the box on the sign-up form.'
              : `Scroll to the end of each to continue. ${
                  !read.terms && !read.privacy ? 'Neither read yet.' : `Still to read: ${read.terms ? 'Privacy policy' : 'Terms of use'}.`
                }`}
          </p>
          <button type="button" className={`${site.button} ${site.primary}`} onClick={onClose}>
            Back to sign up
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default LegalModal;
