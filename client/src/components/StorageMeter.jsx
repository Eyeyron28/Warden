import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { getStorage } from '../services/documentsService.js';
import { formatBytes } from '../utils/listing.js';
import { describeUsage } from '../utils/storageUsage.js';
import styles from './Sidebar.module.css';

/**
 * What this account stores against its quota: files in the vault plus what
 * waits in Trash (still encrypted until removed for good), as a bar, used of
 * quota. The numbers come from GET /api/documents/storage, the same service
 * the server's quota check uses. Collapsed, it is a small ring with a tooltip.
 */
function StorageMeter({ version, compact = false, onTip }) {
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getStorage()
      .then((data) => !cancelled && setUsage(data))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [version]);

  if (!usage) return <div className={compact ? styles.meterCompact : styles.meter} aria-hidden="true" />;
  const view = describeUsage(usage);

  if (compact) {
    const radius = 15;
    const circumference = 2 * Math.PI * radius;
    const tipProps = onTip
      ? {
          onMouseEnter: (event) => onTip.show(event.currentTarget, view.summary),
          onFocus: (event) => onTip.show(event.currentTarget, view.summary),
          onMouseLeave: onTip.hide,
          onBlur: onTip.hide,
        }
      : {};
    return (
      <Link to="/trash" className={styles.meterCompact} aria-label={view.summary} {...tipProps}>
        <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
          <circle cx="20" cy="20" r={radius} fill="none" className={styles.ringTrack} strokeWidth="5" />
          <circle
            cx="20"
            cy="20"
            r={radius}
            fill="none"
            className={view.nearlyFull ? styles.ringFull : styles.ringUsed}
            strokeWidth="5"
            strokeDasharray={`${(view.usedPercent / 100) * circumference} ${circumference}`}
            strokeLinecap="round"
            transform="rotate(-90 20 20)"
          />
        </svg>
      </Link>
    );
  }

  return (
    <div className={styles.meter}>
      <p className={styles.meterTotal}>
        {formatBytes(usage.usedBytes)} <span className={styles.meterFaint}>of {formatBytes(usage.quotaBytes)} used</span>
      </p>
      <div
        className={`${styles.meterBar} ${view.nearlyFull ? styles.meterBarFull : ''}`}
        role="img"
        aria-label={view.summary}
      >
        <span className={styles.meterFiles} style={{ width: `${view.filesPercent}%` }} />
        <span className={styles.meterTrash} style={{ width: `${view.trashPercent}%` }} />
      </div>
      {view.nearlyFull && <p className={styles.meterWarn}>{view.full ? 'Storage is full.' : 'Almost full.'} Empty Trash or delete files.</p>}
      <p className={styles.meterLine}>
        <span className={styles.dotFiles} aria-hidden="true" />
        {formatBytes(usage.fileBytes)} in {usage.fileCount} file{usage.fileCount === 1 ? '' : 's'}
      </p>
      <p className={styles.meterLine}>
        <span className={styles.dotTrash} aria-hidden="true" />
        <Link to="/trash" className={styles.meterLink}>
          {formatBytes(usage.trashBytes)} in Trash
        </Link>
      </p>
    </div>
  );
}

export default StorageMeter;
