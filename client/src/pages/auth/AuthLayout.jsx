import VaultDial from '../../components/VaultDial.jsx';
import site from '../../components/site/site.module.css';
import styles from './auth.module.css';

/**
 * Frame for every auth screen.
 *
 *  - Desktop landscape (1024px and wider): two columns centred in the viewport.
 *    On the left, the vault dial large, with the wordmark and a tagline under it
 *    (decorative: aria-hidden, nothing focusable). On the right, the heading, helper
 *    text and the form, centred on the same horizontal axis as the dial.
 *  - Everything else (phones, tablets in portrait, narrow windows): one column, as
 *    before - the dial small and above the form, and only when a screen asks for it.
 *
 * `layout="stacked"` opts out of the two columns (the Account page uses this frame
 * inside the app shell, where a big brand column would be out of place).
 */
function AuthLayout({ title, subtitle, dial, children, footer, wide = false, layout = 'split' }) {
  const split = layout === 'split';
  return (
    <div className={`${site.container} ${styles.wrap} ${split ? styles.split : ''}`} data-auth-shell={split ? '' : undefined}>
      {split && (
        <aside className={styles.brand} aria-hidden="true">
          <div className={styles.brandDial}>
            <VaultDial status={dial || 'idle'} />
          </div>
          <div className={styles.brandText}>
            <p className={styles.brandName}>Warden</p>
            <p className={styles.brandTagline}>An encrypted vault for the documents you can’t afford to lose.</p>
          </div>
        </aside>
      )}
      <div className={`${styles.column} ${wide ? styles.columnWide : ''}`}>
        <div className={styles.content}>
          {dial && (
            <div className={styles.dial}>
              <VaultDial status={dial} />
            </div>
          )}
          <h1 className={styles.title}>{title}</h1>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          <div className={styles.body}>{children}</div>
          {footer && <div className={styles.footer}>{footer}</div>}
        </div>
      </div>
    </div>
  );
}

export default AuthLayout;
