import { Folder } from '@phosphor-icons/react';

import styles from './FolderTile.module.css';

/**
 * One folder tile in the Drive-style grid VaultShell renders above the
 * document list at the current path. `name` is just the folder's own last
 * path segment (the tree itself lives in currentPath, not in this
 * component); `itemCount` is the number of documents nested anywhere
 * underneath it, including in its own subfolders, matching how Drive's
 * folder tiles count contents.
 */
function FolderTile({ name, itemCount, onOpen }) {
  return (
    <li>
      <button
        type="button"
        className={styles.tile}
        onClick={onOpen}
        aria-label={`Open folder ${name}`}
      >
        <Folder size={32} weight="fill" className={styles.icon} />
        <span className={styles.name} title={name}>
          {name}
        </span>
        <span className={styles.count}>
          {itemCount} item{itemCount === 1 ? '' : 's'}
        </span>
      </button>
    </li>
  );
}

export default FolderTile;
