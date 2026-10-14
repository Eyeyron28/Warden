import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { getFrequentFiles, peekFrequentFiles } from '../services/insightsService.js';
import { JUST_ASKED_MS } from '../services/dataCache.js';
import FileTypeIcon from './FileTypeIcon.jsx';
import styles from './FrequentFiles.module.css';

/**
 * "Frequently used": the files opened most in the last 30 days, at the top of My files. Hidden while it is
 * empty (or while loading, or if the list could not be loaded): it must never get in the way of the files.
 */
function FrequentFiles() {
  const [items, setItems] = useState(() => peekFrequentFiles() ?? []);

  useEffect(() => {
    let cancelled = false;
    getFrequentFiles({ maxAgeMs: JUST_ASKED_MS })
      .then((list) => !cancelled && setItems(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (items.length === 0) return null;
  return (
    <section className={styles.row} aria-label="Frequently used">
      <h2 className={styles.heading}>Frequently used</h2>
      <ul className={styles.list}>
        {items.map((doc) => (
          <li key={doc.id}>
            <Link
              className={styles.chip}
              to={`/files?path=${encodeURIComponent(doc.folder && doc.folder !== 'root' ? doc.folder : '')}&open=${encodeURIComponent(doc.id)}`}
              title={doc.filename}
            >
              <FileTypeIcon filename={doc.filename} size={20} />
              <span className={styles.name}>{doc.filename}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default FrequentFiles;
