import { useEffect, useState } from 'react';
import { Hourglass, LockOpen } from '@phosphor-icons/react';

import { formatManila } from '../../utils/activityText.js';
import { formatCountdown } from '../../utils/emergencyBanner.js';
import styles from './emergency.module.css';

/** A re-render every second, for the live countdown. */
function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * The open request: when access will be granted (Asia/Manila), a live countdown, and the owner's choices. While it
 * is waiting: Deny, or Approve now (which needs a fresh code). Once the wait has ended it says so and offers
 * "Turn off access" (and Deny, which still works until a session actually starts).
 */
function RequestCard({ request, busy, onDeny, onApproveNow, onTurnOff }) {
  const now = useNow();
  const releaseMs = new Date(request.releaseAt).getTime();
  const ended = request.status === 'released' || releaseMs <= now;
  const sessionStarted = request.status === 'released';

  return (
    <section className={`${styles.card} ${styles.requestCard}`} role="alert" aria-labelledby="request-title" data-testid="request-card" data-state={ended ? 'released' : 'pending'}>
      <div className={styles.requestHead}>
        {ended ? <LockOpen size={28} weight="fill" aria-hidden="true" /> : <Hourglass size={28} weight="fill" aria-hidden="true" />}
        <h2 id="request-title" className={styles.cardTitle}>
          {ended ? 'Your contact can open your vault' : 'Your contact asked for access'}
        </h2>
      </div>

      {ended ? (
        <p className={styles.muted}>
          The waiting period ended at <strong>{formatManila(request.releaseAt)}</strong>. {sessionStarted ? 'A read-only session has started.' : 'They can start a read-only session at any time until this request expires.'}
        </p>
      ) : (
        <>
          <p className={styles.muted}>
            Access will be granted on <strong data-testid="release-time">{formatManila(request.releaseAt)}</strong> unless you deny it.
          </p>
          <p className={styles.countdown} data-testid="countdown" aria-live="off">
            {formatCountdown(releaseMs - now)}
          </p>
        </>
      )}

      <div className={styles.actions}>
        {!sessionStarted && (
          <button type="button" className={styles.danger} onClick={onDeny} disabled={busy}>
            Deny
          </button>
        )}
        {!ended && (
          <button type="button" className={styles.secondary} onClick={onApproveNow} disabled={busy}>
            Approve now
          </button>
        )}
        {ended && (
          <button type="button" className={styles.primary} onClick={onTurnOff} disabled={busy}>
            Turn off access
          </button>
        )}
      </div>
    </section>
  );
}

export default RequestCard;
