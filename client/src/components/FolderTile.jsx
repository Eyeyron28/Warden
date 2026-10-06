import { useState } from 'react';
import { ArrowsOutCardinal, DotsThree, Folder, PencilSimple } from '@phosphor-icons/react';

import DropdownMenu from './DropdownMenu.jsx';
import dropdownStyles from './DropdownMenu.module.css';
import { DRAG_MIME } from '../utils/dragAndDrop.js';
import styles from './FolderTile.module.css';

/**
 * One folder tile in the Drive-style grid VaultShell renders above the
 * document list at the current path. `name` is just the folder's own last
 * path segment (the tree itself lives in currentPath, not in this
 * component); `itemCount` is the number of documents nested anywhere
 * underneath it, including in its own subfolders, matching how Drive's
 * folder tiles count contents.
 *
 * The "⋯" menu (Rename, Move) is hidden in Select mode, where the bulk bar
 * is the place to act on a selection. The tile is also a drop target for
 * a dragged document row (desktop only - see utils/dragAndDrop.js).
 */
function FolderTile({
  name,
  itemCount,
  onOpen,
  selectMode,
  selected,
  onToggleSelect,
  onRename,
  onMove,
  onDropDocument,
}) {
  const [dropActive, setDropActive] = useState(false);

  const acceptsDrag = (event) => Boolean(onDropDocument) && event.dataTransfer.types.includes(DRAG_MIME);

  return (
    <li
      className={`${styles.item} ${dropActive ? styles.dropActive : ''}`}
      onDragOver={(event) => {
        if (!acceptsDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (!dropActive) setDropActive(true);
      }}
      onDragLeave={(event) => {
        // Moving between the tile's own children fires dragleave too.
        if (!event.currentTarget.contains(event.relatedTarget)) setDropActive(false);
      }}
      onDrop={(event) => {
        if (!acceptsDrag(event)) return;
        event.preventDefault();
        setDropActive(false);
        const id = event.dataTransfer.getData(DRAG_MIME);
        if (id) onDropDocument(id);
      }}
    >
      {selectMode && (
        <input
          type="checkbox"
          className={styles.selectCheckbox}
          checked={selected}
          onChange={onToggleSelect}
          aria-label={`Select folder ${name}`}
        />
      )}

      <button type="button" className={styles.tile} onClick={onOpen} aria-label={`Open folder ${name}`}>
        <Folder size={32} weight="fill" className={styles.icon} />
        <span className={styles.name} title={name}>
          {name}
        </span>
        <span className={styles.count}>
          {itemCount} item{itemCount === 1 ? '' : 's'}
        </span>
      </button>

      {!selectMode && (onRename || onMove) && (
        <div className={styles.menu}>
          <DropdownMenu
            align="right"
            trigger={({ toggle, open }) => (
              <button
                type="button"
                className={styles.menuButton}
                onClick={toggle}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={`More actions for folder ${name}`}
              >
                <DotsThree size={18} weight="bold" />
              </button>
            )}
          >
            {({ close }) => (
              <>
                {onRename && (
                  <button
                    type="button"
                    role="menuitem"
                    className={dropdownStyles.option}
                    onClick={() => {
                      close();
                      onRename();
                    }}
                  >
                    <PencilSimple size={18} weight="light" className={dropdownStyles.optionIcon} />
                    <span>Rename</span>
                  </button>
                )}
                {onMove && (
                  <button
                    type="button"
                    role="menuitem"
                    className={dropdownStyles.option}
                    onClick={() => {
                      close();
                      onMove();
                    }}
                  >
                    <ArrowsOutCardinal size={18} weight="light" className={dropdownStyles.optionIcon} />
                    <span>Move to...</span>
                  </button>
                )}
              </>
            )}
          </DropdownMenu>
        </div>
      )}
    </li>
  );
}

export default FolderTile;
