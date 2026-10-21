import { ShieldWarning, Trash, LockKeyOpen, WarningCircle } from '@phosphor-icons/react';

import FileNameLabel from './FileNameLabel.jsx';
import { formatDate } from '../utils/formatDate.js';
import { formatBytes } from '../utils/listing.js';
import styles from './QuarantineList.module.css';
import { shortName } from '../utils/ellipsis.js';

export const HONEST_LINE = 'Warden checks uploads with simple rules. Files that look risky are held here until you decide. This is not a full antivirus.';

/**
 * What the Quarantine page draws, for one state and nothing else (no requests, no router), so every state can be rendered on its
 * own: 'loading' | 'error' | 'empty' | 'list'. The page (pages/QuarantinePage.jsx) owns the data.
 */
export function QuarantineList({ state, items = [], error = '', busyId = null, onRelease, onDelete, onRetry }) {
  if (state === 'loading') {
    return (
      <div className={styles.skeleton} role="status" aria-label="Loading held files" data-testid="quarantine-loading">
        {[0, 1, 2].map((n) => (
          <div key={n} className={styles.skeletonRow} />
        ))}
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div className={styles.notice} role="alert" data-testid="quarantine-error">
        <WarningCircle size={28} weight="duotone" aria-hidden="true" />
        <p>{error || 'Could not load the held files.'}</p>
        <button type="button" className={styles.secondary} onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  if (state === 'empty' || items.length === 0) {
    return (
      <div className={styles.notice} data-testid="quarantine-empty">
        <ShieldWarning size={32} weight="duotone" aria-hidden="true" />
        <p className={styles.noticeTitle}>Nothing is held.</p>
        <p>Every upload so far looked fine.</p>
      </div>
    );
  }
  return (
    <ul className={styles.list} aria-label="Held files" data-testid="quarantine-list">
      {items.map((item) => (
        <li key={item.id} className={styles.row} data-testid="quarantine-row" data-severity={item.severity}>
          <div className={styles.main}>
            <div className={styles.nameLine}>
              <FileNameLabel name={item.name} className={styles.name} />
            </div>
            <p className={styles.meta}>
              {formatBytes(item.size)} · Held {formatDate(item.heldAt)}
            </p>
            <ul className={styles.reasons} aria-label="Why it is held">
              {item.reasons.map((reason) => (
                <li key={reason.code} data-code={reason.code}>
                  {reason.text}
                </li>
              ))}
            </ul>
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.release} onClick={() => onRelease?.(item)} disabled={busyId === item.id} aria-label={`Release ${shortName(item.name)}`} data-tip="Move this file out of quarantine" data-action="release">
              <LockKeyOpen size={18} aria-hidden="true" />
              Release
            </button>
            <button type="button" className={styles.delete} onClick={() => onDelete?.(item)} disabled={busyId === item.id} aria-label={`Delete ${shortName(item.name)}`} data-action="delete">
              <Trash size={18} aria-hidden="true" />
              Delete
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default QuarantineList;
