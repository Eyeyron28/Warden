import { useCallback } from 'react';

import MenuPanel from './MenuPanel.jsx';
import { placeAtPoint } from '../utils/menuPosition.js';
import dropdownStyles from './DropdownMenu.module.css';
import styles from './ContextMenu.module.css';

/**
 * A right-click / long-press / Shift+F10 menu at a point. `items` are
 * `{ label, icon?, onSelect, danger?, disabled?, title? }` or `{ separator: true }`.
 * It is positioned by utils/menuPosition.js (flips and clamps so it stays
 * inside the viewport) and closes itself after an item runs; focus returns to
 * `returnFocus` (the row it was opened from) on Esc.
 */
function ContextMenu({ x, y, items, label, returnFocus, onClose }) {
  const placement = useCallback(
    (size, viewport) => placeAtPoint({ x, y }, size, viewport),
    [x, y]
  );
  const visible = items.filter((item, index, all) => !(item.separator && (index === 0 || index === all.length - 1 || all[index - 1].separator)));

  return (
    <MenuPanel placement={placement} onClose={onClose} returnFocus={returnFocus} label={label}>
      {visible.map((item, index) =>
        item.separator ? (
          // eslint-disable-next-line react/no-array-index-key
          <div key={`sep-${index}`} className={styles.separator} role="separator" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            title={item.title}
            className={`${dropdownStyles.option} ${item.danger ? styles.danger : ''}`}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        )
      )}
    </MenuPanel>
  );
}

export default ContextMenu;
