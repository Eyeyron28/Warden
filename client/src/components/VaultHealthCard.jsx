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
            <svg viewBox="0 0 120 120" className={styles.ring} role="img" aria-label={`Vault health score ${health.score} out of 100`}>
              <circle cx="60" cy="60" r={RADIUS} className={styles.track} />
              <circle
                cx="60"
                cy="60"
                r={RADIUS}
                className={`${styles.arc} ${styles[ringTone(health.score)]}`}
                strokeDasharray={CIRCUMFERENCE}
                strokeDashoffset={CIRCUMFERENCE * (1 - health.score / 100)}
                transform="rotate(-90 60 60)"
              />
              <text x="60" y="60" className={styles.score} textAnchor="middle" dominantBaseline="central" data-testid="health-score">
                {health.score}
              </text>
            </svg>
            <span className={styles.outOf}>out of 100</span>
          </div>

          <ul className={styles.list}>
            {health.items.map((item) => {
              const Icon = STATUS_ICON[item.status] || CheckCircle;
              return (
                <li key={item.id} className={styles.row} data-status={item.status} data-testid={`health-${item.id}`}>
                  <Icon size={22} weight="fill" className={`${styles.icon} ${styles[item.status]}`} aria-hidden="true" />
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
