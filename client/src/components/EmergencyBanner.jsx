import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Lifebuoy, X } from '@phosphor-icons/react';

import { getEmergencyStatus, peekEmergencyStatus } from '../services/emergencyService.js';
import { formatManila } from '../utils/activityText.js';
import { bannerFor, dismissKey } from '../utils/emergencyBanner.js';
import styles from './EmergencyBanner.module.css';

const POLL_MS = 60 * 1000;

const readDismissed = (requestId) => {
  try {
    return requestId ? window.sessionStorage.getItem(dismissKey(requestId)) === '1' : false;
  } catch {
    return false;
  }
};

/**
 * Top of every owner page while an Emergency Access request is open: "Someone requested emergency access. It will
 * be granted on <time> unless you deny it. [Review]". It comes from the server's status, so it is still there after
 * a reload; the owner can dismiss it for this tab's session (that one request only). Nothing is drawn while loading,
 * on an error, or when no request is open.
 */
function EmergencyBanner() {
  const location = useLocation();
  const [status, setStatus] = useState(() => peekEmergencyStatus() ?? null);
  const [dismissedId, setDismissedId] = useState(null);

  // A page change reuses an answer younger than 30 seconds (it used to ask again on EVERY page change); the minute timer
  // below always asks.
  const load = useCallback(async ({ fresh = false } = {}) => {
    try {
      const next = await getEmergencyStatus({ maxAgeMs: fresh ? 0 : 30 * 1000 });
      setStatus(next);
      setDismissedId(next?.request && readDismissed(next.request.id) ? next.request.id : null);
    } catch {
      // never gets in the way
    }
  }, []);

  // On first load, on every page change, and every minute.
  useEffect(() => {
    load();
  }, [load, location.pathname]);
  useEffect(() => {
    // A hidden tab does not poll: every poll counts against the account's request budget.
    const timer = setInterval(() => { if (!document.hidden) load({ fresh: true }); }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const banner = bannerFor(status, { dismissedId, formatWhen: formatManila });
  if (!banner.show) return null;

  return (
    <div className={styles.banner} role="alert" data-testid="emergency-banner">
      <Lifebuoy size={22} weight="fill" className={styles.icon} aria-hidden="true" />
      <p className={styles.text}>
        {banner.text}{' '}
        <Link to="/emergency-access" className={styles.link}>
          Review
        </Link>
      </p>
      <button
        type="button"
        className={styles.close}
        aria-label="Dismiss"
        onClick={() => {
          try {
            window.sessionStorage.setItem(dismissKey(banner.requestId), '1');
          } catch {
            // it comes back on the next load
          }
          setDismissedId(banner.requestId);
        }}
      >
        <X size={16} />
      </button>
    </div>
  );
}

export default EmergencyBanner;
