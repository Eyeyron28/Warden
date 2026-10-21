import { splitForEllipsis } from '../utils/ellipsis.js';
import styles from './FileNameLabel.module.css';

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
