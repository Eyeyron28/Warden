import VaultDial from '../../components/VaultDial.jsx';
import site from '../../components/site/site.module.css';
import styles from './auth.module.css';

function AuthLayout({ title, subtitle, dial, children, footer, wide = false, layout = 'split', resetPage = false }) {
  const split = layout === 'split';
  return (
    <div
      className={split ? `${site.container} ${styles.wrap} ${styles.split}` : styles.appFrame}
      data-auth-shell={split ? '' : undefined}
      data-reset-page={resetPage ? '' : undefined}
    >
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
