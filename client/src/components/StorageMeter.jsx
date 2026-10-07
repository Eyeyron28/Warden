import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { getStorage } from '../services/documentsService.js';
import { formatBytes } from '../utils/listing.js';
import styles from './Sidebar.module.css';

/**
 * What this account stores: files in the vault, and what is waiting in Trash
 * (still encrypted, removed for good after 30 days). There is no quota, so the
 * bar shows how the total splits between the two rather than a fill level.
 */
function StorageMeter({ version }) {
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

  if (!usage) return <div className={styles.meter} aria-hidden="true" />;
  const total = usage.fileBytes + usage.trashBytes;
  const filesShare = total === 0 ? 0 : (usage.fileBytes / total) * 100;

  return (
    <div className={styles.meter}>
      <p className={styles.meterTotal}>
        {formatBytes(total)} <span className={styles.meterFaint}>stored</span>
      </p>
      <div
        className={styles.meterBar}
        role="img"
        aria-label={`${formatBytes(usage.fileBytes)} in files, ${formatBytes(usage.trashBytes)} in Trash`}
      >
        <span className={styles.meterFiles} style={{ width: `${filesShare}%` }} />
        <span className={styles.meterTrash} style={{ width: `${total === 0 ? 0 : 100 - filesShare}%` }} />
      </div>
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
