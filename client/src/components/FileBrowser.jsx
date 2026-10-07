import { useEffect, useRef, useState } from 'react';
import { DotsThree, Folder } from '@phosphor-icons/react';

import DocumentThumb from './DocumentThumb.jsx';
import DropdownMenu from './DropdownMenu.jsx';
import FileTypeIcon from './FileTypeIcon.jsx';
import dropdownStyles from './DropdownMenu.module.css';
import { rowClickAction } from '../utils/clickAction.js';
import { DRAG_MIME, canDragDocuments } from '../utils/dragAndDrop.js';
import styles from './FileBrowser.module.css';

const LONG_PRESS_MS = 550;
const LONG_PRESS_SLOP_PX = 10;

/**
 * "Select all" checkbox with an indeterminate state, for a list header or a
 * toolbar. `header` is 'none' | 'some' | 'all' (see utils/selection.js).
 */
export function SelectAllCheckbox({ header, onChange, label = 'Select all' }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = header === 'some';
  }, [header]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className={styles.headCheck}
      checked={header === 'all'}
      onChange={onChange}
      aria-label={label}
    />
  );
}

/** Puts keyboard focus back on an item (e.g. the card a preview was opened from). */
export function focusBrowserItem(key) {
  const row = [...document.querySelectorAll('[data-file-key]')].find((node) => node.dataset.fileKey === key);
  const target = row?.querySelector('button[title]') ?? row?.querySelector('button');
  if (target) target.focus();
}

const isFolder = (item) => item.kind === 'folder' || item.kind === 'trash-folder';

function ItemIcon({ item, size }) {
  if (isFolder(item)) return <Folder size={size} weight="fill" className={styles.folderIcon} aria-hidden="true" />;
  if (!item.thumbDocument) return null;
  return size >= 28 ? <DocumentThumb document={item.thumbDocument} variant="row" /> : <FileTypeIcon filename={item.name} size={size} />;
}

function ItemMenu({ item, menuItems, placeholder = false }) {
  if (!menuItems || menuItems.length === 0) return placeholder ? <span /> : null;
  return (
    <div className={styles.menu} data-no-open>
      <DropdownMenu
        align="right"
        label={`Actions for ${item.name}`}
        trigger={({ toggle, open }) => (
          <button
            type="button"
            className={styles.menuButton}
            onClick={toggle}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={`More actions for ${item.name}`}
          >
            <DotsThree size={22} weight="bold" />
          </button>
        )}
      >
        {({ close }) =>
          menuItems.map((entry) => (
            <button
              key={entry.label}
              type="button"
              role="menuitem"
              className={`${dropdownStyles.option} ${entry.danger ? styles.dangerOption : ''}`}
              onClick={() => {
                close();
                entry.onSelect();
              }}
            >
              {entry.icon}
              <span>{entry.label}</span>
            </button>
          ))
        }
      </DropdownMenu>
    </div>
  );
}

/**
 * One list or grid of files and folders, shared by My files, Photos and
 * Trash. It owns how an item LOOKS and how a click is interpreted
 * (utils/clickAction.js): a click opens, a click on the checkbox - or Shift or
 * Ctrl/Cmd with a click - selects. Nothing in here downloads anything.
 *
 * Right-click, long-press on a touch screen, and Shift+F10 / the Menu key all
 * call `onItemContextMenu(item, { x, y, opener })`; the page decides what the
 * menu holds. The "..." button opens `menuFor(item)` as a dropdown.
 *
 * items: [{ key, kind: 'file'|'folder'|'trash-file'|'trash-folder', name,
 *   subtitle?, badge?, thumbDocument?, cells?: { [columnId]: node } }]
 * columns: [{ id, label, width, align? }] - fixed, proportional widths; the
 *   name column takes whatever is left.
 */
function FileBrowser({
  items,
  view,
  selection,
  onOpen,
  columns = [],
  menuFor,
  onItemContextMenu,
  onDropOnFolder,
  showListHeader = true,
  label,
}) {
  const [draggable] = useState(canDragDocuments);
  const [dropKey, setDropKey] = useState(null);
  const press = useRef(null);
  const suppressClickUntil = useRef(0);
  const anySelected = selection.count > 0;

  const handleClick = (item, event) => {
    if (Date.now() < suppressClickUntil.current) return;
    if (event.target.closest('[data-no-open]')) return;
    const action = rowClickAction(item, { shift: event.shiftKey, ctrl: event.ctrlKey, meta: event.metaKey });
    if (action === 'range') selection.click(item.key, { shift: true });
    else if (action === 'toggle') selection.click(item.key, { shift: false });
    else onOpen(item);
  };

  const openContext = (item, x, y, opener) => onItemContextMenu?.(item, { x, y, opener });

  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };

  const touchProps = (item) =>
    onItemContextMenu
      ? {
          onPointerDown: (event) => {
            if (event.pointerType === 'mouse' || event.target.closest('[data-no-open]')) return;
            cancelPress();
            const { clientX, clientY, currentTarget } = event;
            press.current = {
              x: clientX,
              y: clientY,
              timer: setTimeout(() => {
                press.current = null;
                // The tap that ends this press must not also open the file.
                suppressClickUntil.current = Date.now() + 700;
                if (navigator.vibrate) navigator.vibrate(10);
                openContext(item, clientX, clientY, currentTarget.querySelector('button[title]'));
              }, LONG_PRESS_MS),
            };
          },
          onPointerMove: (event) => {
            const start = press.current;
            if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP_PX) cancelPress();
          },
          onPointerUp: cancelPress,
          onPointerCancel: cancelPress,
        }
      : {};

  const checkbox = (item) => (
    <span className={styles.check} data-no-open>
      <input
        type="checkbox"
        checked={selection.isSelected(item.key)}
        onChange={() => {}}
        onClick={(event) => {
          event.stopPropagation();
          selection.click(item.key, { shift: event.shiftKey });
        }}
        aria-label={`Select ${item.name}`}
      />
    </span>
  );

  const dropProps = (item) => {
    if (!onDropOnFolder || item.kind !== 'folder') return {};
    const accepts = (event) => event.dataTransfer.types.includes(DRAG_MIME);
    return {
      onDragOver: (event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (dropKey !== item.key) setDropKey(item.key);
      },
      onDragLeave: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setDropKey(null);
      },
      onDrop: (event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        setDropKey(null);
        const id = event.dataTransfer.getData(DRAG_MIME);
        if (id) onDropOnFolder(id, item);
      },
    };
  };

  const dragProps = (item) =>
    draggable && onDropOnFolder && item.kind === 'file'
      ? {
          draggable: true,
          onDragStart: (event) => {
            event.dataTransfer.setData(DRAG_MIME, item.id);
            event.dataTransfer.effectAllowed = 'move';
          },
        }
      : {};

  const common = (item) => ({
    'data-file-key': item.key,
    'data-selected': selection.isSelected(item.key) || undefined,
    'data-drop': dropKey === item.key || undefined,
    onClick: (event) => handleClick(item, event),
    // Shift-click must not start a text selection.
    onMouseDown: (event) => {
      if (event.shiftKey) event.preventDefault();
    },
    onContextMenu: onItemContextMenu
      ? (event) => {
          event.preventDefault();
          event.stopPropagation();
          // A touch long-press already opened it from the timer.
          if (Date.now() < suppressClickUntil.current) return;
          openContext(item, event.clientX, event.clientY, event.currentTarget.querySelector('button[title]'));
        }
      : undefined,
    onKeyDown: onItemContextMenu
      ? (event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            const anchor = event.currentTarget.querySelector('button[title]') ?? event.currentTarget;
            const rect = anchor.getBoundingClientRect();
            openContext(item, rect.left + 12, rect.bottom - 4, anchor);
          }
        }
      : undefined,
    ...touchProps(item),
    ...dropProps(item),
    ...dragProps(item),
  });

  if (view === 'grid') {
    return (
      <ul className={styles.grid} data-any-selected={anySelected || undefined} aria-label={label}>
        {items.map((item) => (
          <li key={item.key} className={styles.card} {...common(item)}>
            <div className={styles.cardThumb}>
              {isFolder(item) ? (
                <Folder size={72} weight="fill" className={styles.folderIconLarge} aria-hidden="true" />
              ) : (
                <DocumentThumb document={item.thumbDocument} variant="fill" />
              )}
            </div>
            <div className={styles.cardFooter}>
              {checkbox(item)}
              <span className={styles.cardIcon}>
                <ItemIcon item={item} size={isFolder(item) ? 22 : 20} />
              </span>
              <span className={styles.cardText}>
                <button type="button" className={styles.cardName} title={item.name}>
                  {item.name}
                </button>
                {item.subtitle && <span className={styles.cardMeta}>{item.subtitle}</span>}
                {item.badge}
              </span>
              <ItemMenu item={item} menuItems={menuFor?.(item)} />
            </div>
          </li>
        ))}
      </ul>
    );
  }

  const wide = ['var(--check-w)', 'var(--icon-w)', 'minmax(0, 1fr)', ...columns.map((column) => column.width), '44px'].join(' ');
  const narrow = ['var(--check-w)', 'var(--icon-w)', 'minmax(0, 1fr)', '44px'].join(' ');
  const gridVars = { '--cols-wide': wide, '--cols-narrow': narrow };

  return (
    <ul className={styles.list} data-any-selected={anySelected || undefined} style={gridVars} aria-label={label}>
      {showListHeader && (
        <li className={`${styles.row} ${styles.headRow}`}>
          <span className={styles.headCheckCell}>
            <SelectAllCheckbox header={selection.header} onChange={() => (selection.header === 'all' ? selection.clear() : selection.selectAll())} />
          </span>
          <span />
          <span className={styles.headLabel}>Name</span>
          {columns.map((column) => (
            <span key={column.id} className={`${styles.headLabel} ${styles.cell}`} style={{ textAlign: column.align }}>
              {column.label}
            </span>
          ))}
          <span />
        </li>
      )}
      {items.map((item) => (
        <li key={item.key} className={styles.row} {...common(item)}>
          {checkbox(item)}
          <span className={styles.leadIcon}>
            <ItemIcon item={item} size={28} />
          </span>
          <span className={styles.nameCell}>
            <button type="button" className={styles.name} title={item.name}>
              {item.name}
            </button>
            <span className={styles.subline}>
              {item.badge}
              {item.subtitle && <span className={styles.mobileMeta}>{item.subtitle}</span>}
            </span>
          </span>
          {columns.map((column) => (
            <span key={column.id} className={`${styles.cell} ${styles.metaCell}`} style={{ textAlign: column.align }}>
              {item.cells?.[column.id]}
            </span>
          ))}
          <ItemMenu item={item} menuItems={menuFor?.(item)} placeholder />
        </li>
      ))}
    </ul>
  );
}

export default FileBrowser;
