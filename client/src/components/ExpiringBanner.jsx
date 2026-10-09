import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarX, X } from '@phosphor-icons/react';

import { listExpiringDocuments } from '../services/documentsService.js';
import styles from './ExpiringBanner.module.css';

const DISMISS_KEY = 'warden.expiryBannerDismissed';
const readDismissed = () => {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * A dismissible heads-up at the top of My files: documents that have expired or expire within 60 days.
 * Dismissing hides it for this tab's session. It never gets in the way: nothing is drawn while loading, on an
 * error, or when there is nothing to report.
 */
function ExpiringBanner() {
  const [items, setItems] = useState([]);
  const [dismissed, setDismissed] = useState(readDismissed);

  useEffect(() => {
    let cancelled = false;
    listExpiringDocuments()
      .then((list) => !cancelled && setItems(Array.isArray(list) ? list : []))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (dismissed || items.length === 0) return null;
  const expired = items.filter((doc) => doc.expiryStatus === 'expired').length;
  const soon = items.length - expired;
  const parts = [];
  if (expired) parts.push(`${expired} expired`);
  if (soon) parts.push(`${soon} expiring within 60 days`);

  return (
    <div className={styles.banner} role="status" data-testid="expiry-banner">
      <CalendarX size={20} weight="fill" className={expired ? styles.iconBad : styles.iconWarn} aria-hidden="true" />
      <p className={styles.text}>
        <strong>{items.length === 1 ? '1 document needs attention' : `${items.length} documents need attention`}:</strong> {parts.join(', ')}.{' '}
        <Link to="/overview#expiring" className={styles.link}>
          Review
        </Link>
      </p>
      <button
        type="button"
        className={styles.close}
        aria-label="Dismiss"
        onClick={() => {
          try {
            window.sessionStorage.setItem(DISMISS_KEY, '1');
          } catch {
            // the banner just comes back next time
          }
          setDismissed(true);
        }}
      >
        <X size={16} />
      </button>
    </div>
  );
}

export default ExpiringBanner;
