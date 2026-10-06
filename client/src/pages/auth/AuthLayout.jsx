import VaultDial from '../../components/VaultDial.jsx';
import site from '../../components/site/site.module.css';
import styles from './auth.module.css';

/**
 * Frame for every auth screen: one centered column, an optional vault
 * dial (the same animated lock the vault itself uses, so login feels
 * continuous with what comes after it), one h1, and the form.
 */
function AuthLayout({ title, subtitle, dial, children, footer, wide = false }) {
  return (
    <div className={`${site.container} ${styles.wrap}`}>
      <div className={`${styles.column} ${wide ? styles.columnWide : ''}`}>
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
  );
}

export default AuthLayout;
