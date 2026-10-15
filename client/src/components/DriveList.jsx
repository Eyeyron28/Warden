import { Link } from 'react-router-dom';

import { InfoButton, StarButton } from './FileBrowser.jsx';
import FileTypeIcon from './FileTypeIcon.jsx';
import { formatDate } from '../utils/formatDate.js';
import { formatBytes } from '../utils/listing.js';
import styles from './DriveList.module.css';

// A file opens in its folder on My files (the same address Overview uses).
const openLink = (doc) => `/files?path=${encodeURIComponent(doc.folder && doc.folder !== 'root' ? doc.folder : '')}&open=${encodeURIComponent(doc.id)}`;

/**
 * A plain list of files for the Starred and Recent views: type icon, name (opens the file in its folder), where it is, one
 * line of facts, a star and the details button. `note(doc)` adds a line under the name (Recent says where it was opened).
 */
function DriveList({ items, label, note, onToggleStar, onShowDetails }) {
  return (
    <ul className={styles.list} aria-label={label}>
      {items.map((doc) => (
        <li key={doc.id} className={styles.row}>
          <span className={styles.icon}>
            <FileTypeIcon filename={doc.filename} size={28} />
          </span>
          <span className={styles.text}>
            <Link to={openLink(doc)} className={styles.name}>
              {doc.filename}
            </Link>
            <span className={styles.meta}>
              {doc.folder && doc.folder !== 'root' ? `${doc.folder} · ` : 'My files · '}
              {formatDate(doc.updatedAt || doc.createdAt)} · {formatBytes(doc.size)}
            </span>
            {note && <span className={styles.note}>{note(doc)}</span>}
          </span>
          <span className={styles.actions}>
            <StarButton name={doc.filename} starred={doc.starred} onToggle={() => onToggleStar(doc)} />
            <InfoButton name={doc.filename} onShow={(opener) => onShowDetails(doc, opener)} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export default DriveList;
