import { CaretRight, House } from '@phosphor-icons/react';

import FolderGlyph from './FolderGlyph.jsx';
import { useFolderStyles } from '../services/folderStyles.js';
import { splitPath, joinPath } from '../utils/folderPath.js';
import styles from './FolderBreadcrumb.module.css';

function FolderBreadcrumb({ path, onNavigate, rootLabel = 'My files' }) {
  const segments = splitPath(path);
  const looks = useFolderStyles();

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
        <span>{rootLabel}</span>
      </button>

      {segments.map((segment, index) => {
        const isLast = index === segments.length - 1;
        const segmentPath = joinPath(segments.slice(0, index + 1));
        const look = looks[segmentPath];
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
              {look && <FolderGlyph icon={look.icon} color={look.color} size={14} />}
              {segment}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

export default FolderBreadcrumb;
