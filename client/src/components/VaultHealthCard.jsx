import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle, WarningCircle, XCircle } from '@phosphor-icons/react';

import { getVaultHealth } from '../services/accountService.js';
import { extractErrorMessage } from '../services/api.js';
import styles from './VaultHealthCard.module.css';

const ACTION_LABEL = {
  open_shares: 'Review share links',
  old_shares: 'Review share links',
  trusted_browsers: 'Manage devices',
  stale_trusted: 'Manage devices',
  suspicious: 'Review activity',
  expired_docs: 'Review documents',
  expiring_docs: 'Review documents',
  reminders_off: 'Turn on reminders',
  trash_near_purge: 'Open Trash',
};

const STATUS_ICON = { ok: CheckCircle, warn: WarningCircle, bad: XCircle };
const STATUS_WORD = { ok: 'OK', warn: 'Needs a look', bad: 'Needs action' };
const RADIUS = 52;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** 'ok' from 80, 'warn' from 50, otherwise 'bad': only the ring's colour. */
export function ringTone(score) {
  return score >= 80 ? 'ok' : score >= 50 ? 'warn' : 'bad';
}

/** The score as a ring, then the checklist that makes it up. Each row says what was counted. */
function VaultHealthCard({ reloadKey = 0 }) {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState('');
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError('');
    getVaultHealth()
      .then((result) => !cancelled && setHealth(result))
      .catch((err) => !cancelled && setError(extractErrorMessage(err, 'Could not load the vault health.')));
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return (
    <section className={styles.card} aria-labelledby="health-title" data-testid="vault-health">
      <h2 id="health-title" className={styles.heading}>
        Vault health
      </h2>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {!health && !error && <p className={styles.note}>Loading…</p>}
      {health && (
        <div className={styles.body}>
          <div className={styles.ringBox}>
            {/* Tapping the ring plays one quick glow pulse (touch screens have no hover). */}
            <div
              className={`${styles.ringWrap} ${styles[ringTone(health.score)]} ${pulse ? styles.tapPulse : ''}`}
              style={{ '--score': health.score }}
              onClick={() => setPulse(true)}
              onAnimationEnd={(event) => event.animationName.includes('tap') && setPulse(false)}
            >
              <svg viewBox="0 0 120 120" className={styles.ring} role="img" aria-label={`Vault health score ${health.score} out of 100`}>
                <circle cx="60" cy="60" r={RADIUS} className={styles.track} />
                <circle
                  cx="60"
                  cy="60"
                  r={RADIUS}
                  className={styles.arcGlow}
                  aria-hidden="true"
                  strokeDasharray={CIRCUMFERENCE}
                  strokeDashoffset={CIRCUMFERENCE * (1 - health.score / 100)}
                  transform="rotate(-90 60 60)"
                />
                <circle
                  cx="60"
                  cy="60"
                  r={RADIUS}
                  className={styles.arc}
                  strokeDasharray={CIRCUMFERENCE}
                  strokeDashoffset={CIRCUMFERENCE * (1 - health.score / 100)}
                  transform="rotate(-90 60 60)"
                />
                <g className={styles.orbit} aria-hidden="true">
                  <circle cx="60" cy="8" r="3.4" className={styles.dot} />
                </g>
              </svg>
              {/* One centered layer inside the ring. The real number is the text of the first span (read by tests); CSS draws the
                  same number from a counter in that same box, so the count-up ends exactly where the final number sits. */}
              <div className={styles.center} aria-hidden="true">
                <span className={styles.num} data-wide={health.score >= 100 ? '' : undefined} data-testid="health-score">
                  {health.score}
                </span>
                <span className={styles.outOf}>out of 100</span>
              </div>
            </div>
          </div>

          <ul className={styles.list}>
            {health.items.map((item) => {
              const Icon = STATUS_ICON[item.status] || CheckCircle;
              return (
                <li key={item.id} className={styles.row} data-status={item.status} data-testid={`health-${item.id}`}>
                  <Icon size={30} weight="fill" className={`${styles.icon} ${styles[item.status]}`} aria-hidden="true" />
                  <div className={styles.text}>
                    <span className={styles.label}>
                      {item.label} <span className={styles.status}>{STATUS_WORD[item.status]}</span>
                    </span>
                    <span className={styles.detail}>{item.detail}</span>
                  </div>
                  {item.status !== 'ok' && (
                    <Link to={item.actionPath} className={styles.fix}>
                      {ACTION_LABEL[item.id] || 'Fix this'}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <p className={styles.note}>This score reflects settings Warden can see. It is not a security guarantee.</p>
    </section>
  );
}

export default VaultHealthCard;
