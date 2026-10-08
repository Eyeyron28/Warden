import { Link } from 'react-router-dom';

import { PROJECT } from '../../config.js';
import site from './site.module.css';
import styles from './SiteFooter.module.css';

function SiteFooter({ compact = false }) {
  return (
    <footer className={`${styles.footer} ${compact ? styles.compact : ''}`}>
      <div className={`${site.container} ${styles.inner}`}>
        <div className={styles.about}>
          <p className={styles.name}>Warden</p>
          <p className={styles.disclaimer}>
            A student capstone project ({PROJECT.program} {PROJECT.course}, {PROJECT.group}, {PROJECT.school}),
            provided as-is. Keep your own copies of anything you can&apos;t afford to lose.
          </p>
        </div>

        <nav className={styles.columns} aria-label="Footer">
          <div className={styles.column}>
            <p className={styles.heading}>Product</p>
            <Link to="/#how-it-works">How it works</Link>
            <Link to="/signup">Create a vault</Link>
            <Link to="/login">Log in</Link>
          </div>
          <div className={styles.column}>
            <p className={styles.heading}>Project</p>
            <Link to="/#about">About</Link>
            <Link to="/#contact">Contact</Link>
          </div>
          <div className={styles.column}>
            <p className={styles.heading}>Legal</p>
            <Link to="/privacy">Privacy</Link>
            <Link to="/terms">Terms</Link>
          </div>
        </nav>
      </div>
      <div className={`${site.container} ${styles.bottom}`}>
        <p>&copy; {new Date().getFullYear()} Warden, {PROJECT.group}.</p>
      </div>
      {compact && (
        <div className={`${site.container} ${styles.compactBar}`}>
          <p>&copy; {new Date().getFullYear()} Warden, {PROJECT.group}.</p>
          <nav aria-label="Legal">
            <Link to="/privacy">Privacy</Link>
            <Link to="/terms">Terms</Link>
          </nav>
        </div>
      )}
    </footer>
  );
}

export default SiteFooter;
