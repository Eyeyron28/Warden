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

function EmergencyBanner() {
  const location = useLocation();
  const [status, setStatus] = useState(() => peekEmergencyStatus() ?? null);
  const [dismissedId, setDismissedId] = useState(null);

  const load = useCallback(async ({ fresh = false } = {}) => {
    try {
      const next = await getEmergencyStatus({ maxAgeMs: fresh ? 0 : 30 * 1000 });
      setStatus(next);
      setDismissedId(next?.request && readDismissed(next.request.id) ? next.request.id : null);
    } catch {
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, location.pathname]);
  useEffect(() => {
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
