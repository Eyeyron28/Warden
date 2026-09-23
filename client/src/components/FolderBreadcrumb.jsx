import { CaretRight, House } from '@phosphor-icons/react';

import { splitPath, joinPath } from '../utils/folderPath.js';
import styles from './FolderBreadcrumb.module.css';

/**
 * Drive-style breadcrumb replacing the old flat All/folder-name tab bar
 * (FolderFilter) - `path` is the same slash-delimited string VaultShell
 * tracks as `currentPath`. Every crumb before the last is a link back up
 * to that point in the tree; the last one is the current location and
 * isn't clickable, matching how Drive's own breadcrumb behaves.
 */
function FolderBreadcrumb({ path, onNavigate }) {
  const segments = splitPath(path);

  return (
    <nav className={styles.breadcrumb} aria-label="Folder path">
      <button
        type="button"
        className={styles.crumb}
        onClick={() => onNavigate('')}
        aria-current={segments.length === 0 ? 'page' : undefined}
        disabled={segments.length === 0}
      >
        <House size={14} weight="bold" />
        <span>Documents</span>
      </button>

      {segments.map((segment, index) => {
        const isLast = index === segments.length - 1;
        const segmentPath = joinPath(segments.slice(0, index + 1));
        return (
          <span key={segmentPath} className={styles.crumbGroup}>
            <CaretRight size={12} weight="bold" className={styles.separator} />
            <button
              type="button"
              className={styles.crumb}
              onClick={() => onNavigate(segmentPath)}
              aria-current={isLast ? 'page' : undefined}
              disabled={isLast}
            >
              {segment}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

export default FolderBreadcrumb;
