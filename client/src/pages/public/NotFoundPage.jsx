import { Link } from 'react-router-dom';

import { usePageMeta } from '../../utils/usePageMeta.js';
import site from '../../components/site/site.module.css';
import styles from './NotFoundPage.module.css';

function NotFoundPage() {
  usePageMeta('Page not found', 'This page does not exist.');
  return (
    <div className={`${site.container} ${styles.wrap}`}>
      <p className={styles.code}>404</p>
      <h1 className={styles.title}>There&apos;s nothing at this address.</h1>
      <p className={styles.body}>The link may be old or mistyped. Nothing was lost; this page just doesn&apos;t exist.</p>
      <div className={styles.actions}>
        <Link to="/" className={`${site.button} ${site.primary}`}>
          Back to the home page
        </Link>
        <Link to="/login" className={`${site.button} ${site.ghost}`}>
          Log in
        </Link>
      </div>
    </div>
  );
}

export default NotFoundPage;
