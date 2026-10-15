import { splitForEllipsis } from '../utils/ellipsis.js';
import styles from './FileNameLabel.module.css';

/**
 * A file or folder name on ONE line, cut in the MIDDLE when it does not fit (the extension stays visible). The full name is the
 * tooltip and the accessible name. It never makes its container wider: put it anywhere, it shrinks to what is there.
 */
function FileNameLabel({ name, className = '' }) {
  const { head, tail } = splitForEllipsis(name);
  return (
    <span className={`${styles.name} ${className}`} title={name} aria-label={name}>
      <span className={styles.head} aria-hidden="true">
        {head}
      </span>
      <span className={styles.tail} aria-hidden="true">
        {tail}
      </span>
    </span>
  );
}

export default FileNameLabel;
