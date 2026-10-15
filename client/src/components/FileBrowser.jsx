import { useEffect, useRef, useState } from 'react';
import { DotsThree, Info, NoteBlank, Star } from '@phosphor-icons/react';

import DocumentThumb from './DocumentThumb.jsx';
import DropdownMenu from './DropdownMenu.jsx';
import FolderGlyph from './FolderGlyph.jsx';
import FileTypeIcon from './FileTypeIcon.jsx';
import dropdownStyles from './DropdownMenu.module.css';
import { rowClickAction } from '../utils/clickAction.js';
import { DRAG_MIME, canDragDocuments } from '../utils/dragAndDrop.js';
import { useProgressiveList } from '../utils/useProgressiveList.js';
import { idsFromDrag } from '../utils/dragMove.js';
import { useFolderStyles } from '../services/folderStyles.js';
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

function ItemIcon({ item, size, look }) {
  if (isFolder(item)) return <FolderGlyph icon={look?.icon} color={look?.color} size={size} className={styles.folderIcon} />;
  if (!item.thumbDocument) return null;
  return size >= 28 ? <DocumentThumb document={item.thumbDocument} variant="row" /> : <FileTypeIcon filename={item.name} size={size} />;
}

/** A star on a file: on or off, announced as a toggle. Shown on hover, on focus, always when starred, and always on touch. */
export function StarButton({ name, starred, onToggle }) {
  return (
    <button
      type="button"
      className={styles.starButton}
      data-starred={starred || undefined}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      aria-pressed={Boolean(starred)}
      aria-label={`${starred ? 'Remove the star from' : 'Star'} ${name}`}
      title={starred ? 'Starred' : 'Star'}
    >
      <Star size={18} weight={starred ? 'fill' : 'regular'} />
    </button>
  );
}

/** A small marker on a file that has a private note. Only THAT a note exists is known here, never what it says. */
export function NoteMarker() {
  return (
    <span className={styles.noteMarker} role="img" aria-label="Has a private note" title="Has a private note">
      <NoteBlank size={14} weight="fill" />
    </span>
  );
}

export function InfoButton({ name, onShow }) {
  return (
    <button
      type="button"
      className={styles.infoButton}
      onClick={(event) => {
        event.stopPropagation();
        onShow(event.currentTarget);
      }}
      aria-label={`Details for ${name}`}
      aria-haspopup="dialog"
      title="Details"
    >
      <Info size={18} />
    </button>
  );
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
  // Star and details for FILES (the pages that offer them pass these; Trash and read-only views do not).
  onToggleStar,
  onShowDetails,
  showListHeader = true,
  // false = read-only browsing (Emergency Access): no checkboxes, no select-all, a click always opens.
  selectable = true,
  label,
}) {
  // The first rows now, the rest in steps while the browser is idle (utils/useProgressiveList.js).
  const shownItems = useProgressiveList(items);
  const [draggable] = useState(canDragDocuments);
  const looks = useFolderStyles();
  const hasFileActions = Boolean(onToggleStar || onShowDetails);
  const [dropKey, setDropKey] = useState(null);
  const press = useRef(null);
  const suppressClickUntil = useRef(0);
  const anySelected = selection.count > 0;

  const handleClick = (item, event) => {
    if (Date.now() < suppressClickUntil.current) return;
    if (event.target.closest('[data-no-open]')) return;
    const action = selectable ? rowClickAction(item, { shift: event.shiftKey, ctrl: event.ctrlKey, meta: event.metaKey }) : 'open';
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
                // A long press on a touch screen enters select mode (the checkboxes appear and every tap then selects); the
                // "..." button still opens the actions menu. Read-only views have nothing to select, so they keep the menu.
                if (selectable) selection.toggle(item.key);
                else openContext(item, clientX, clientY, currentTarget.querySelector('button[title]'));
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

  const renderCheckbox = (item) => (
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

  // Read-only browsing keeps the (empty, zero-width) cell so the grid columns still line up.
  const checkbox = (item) => (selectable ? renderCheckbox(item) : <span className={styles.check} data-no-open aria-hidden="true" />);

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
        const ids = idsFromDrag(event);
        if (ids.length) onDropOnFolder(ids, item);
      },
    };
  };

  const dragProps = (item) =>
    draggable && onDropOnFolder && item.kind === 'file'
      ? {
          draggable: true,
          onDragStart: (event) => {
            // Dragging a selected file takes the whole selection of files with it; any other file goes alone.
            const ids = selection.isSelected(item.key)
              ? items.filter((entry) => entry.kind === 'file' && selection.isSelected(entry.key)).map((entry) => entry.id)
              : [item.id];
            event.dataTransfer.setData(DRAG_MIME, ids.join(','));
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

  // The buttons at the end of a row or card: star and details for a file, then the "..." menu.
  const actionsFor = (item) => (
    <span className={styles.actions} data-no-open>
      {hasFileActions && item.kind === 'file' && item.document && (
        <>
          {onToggleStar && <StarButton name={item.name} starred={item.document.starred} onToggle={() => onToggleStar(item)} />}
          {onShowDetails && <InfoButton name={item.name} onShow={(opener) => onShowDetails(item, opener)} />}
        </>
      )}
      <ItemMenu item={item} menuItems={menuFor?.(item)} placeholder />
    </span>
  );

  // Folders on their own: a responsive grid of compact tiles (the folder's colour and icon, its name, how many items it holds).
  if (view === 'tiles') {
    return (
      <ul className={styles.tiles} data-any-selected={anySelected || undefined} aria-label={label}>
        {shownItems.map((item) => (
          <li key={item.key} className={styles.tile} {...common(item)}>
            {checkbox(item)}
            <span className={styles.tileIcon}>
              <ItemIcon item={item} size={28} look={looks[item.path]} />
            </span>
            <span className={styles.tileText}>
              <button type="button" className={styles.tileName} title={item.name}>
                {item.name}
              </button>
              {item.subtitle && <span className={styles.tileMeta}>{item.subtitle}</span>}
            </span>
            {actionsFor(item)}
          </li>
        ))}
      </ul>
    );
  }

  if (view === 'grid') {
    return (
      <ul className={styles.grid} data-any-selected={anySelected || undefined} aria-label={label}>
        {shownItems.map((item) => (
          <li key={item.key} className={styles.card} {...common(item)}>
            <div className={styles.cardThumb}>
              {isFolder(item) ? (
                <FolderGlyph icon={looks[item.path]?.icon} color={looks[item.path]?.color} size={72} className={styles.folderIconLarge} />
              ) : (
                <DocumentThumb document={item.thumbDocument} variant="fill" />
              )}
            </div>
            <div className={styles.cardFooter}>
              {checkbox(item)}
              <span className={styles.cardIcon}>
                <ItemIcon item={item} size={isFolder(item) ? 22 : 20} look={looks[item.path]} />
              </span>
              <span className={styles.cardText}>
                <button type="button" className={styles.cardName} title={item.name}>
                  {item.name}
                </button>
                {item.subtitle && <span className={styles.cardMeta}>{item.subtitle}</span>}
                {item.document?.hasNote && <NoteMarker />}
                {item.badge}
              </span>
              {actionsFor(item)}
            </div>
          </li>
        ))}
      </ul>
    );
  }

  const wide = ['var(--check-w)', 'var(--icon-w)', 'minmax(0, 1fr)', ...columns.map((column) => column.width), 'var(--actions-w)'].join(' ');
  const narrow = ['var(--check-w)', 'var(--icon-w)', 'minmax(0, 1fr)', 'var(--actions-w)'].join(' ');
  const gridVars = {
    '--cols-wide': wide,
    '--cols-narrow': narrow,
    // Room at the end of a row for star, details and the menu (just the menu where a page offers no file actions).
    '--actions-w': hasFileActions ? '120px' : '44px',
    ...(selectable ? {} : { '--check-w': '0px' }),
  };

  return (
    <ul className={styles.list} data-any-selected={anySelected || undefined} style={gridVars} aria-label={label}>
      {showListHeader && (
        <li className={`${styles.row} ${styles.headRow} ${columns.length > 3 ? styles.manyCols : ''}`}>
          <span className={styles.headCheckCell}>
            {selectable ? (
              <SelectAllCheckbox header={selection.header} onChange={() => (selection.header === 'all' ? selection.clear() : selection.selectAll())} />
            ) : null}
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
      {shownItems.map((item) => (
        <li key={item.key} className={`${styles.row} ${columns.length > 3 ? styles.manyCols : ''}`} {...common(item)}>
          {checkbox(item)}
          <span className={styles.leadIcon}>
            <ItemIcon item={item} size={28} look={looks[item.path]} />
          </span>
          <span className={styles.nameCell}>
            <button type="button" className={styles.name} title={item.name}>
              {item.name}
            </button>
            <span className={styles.subline}>
              {item.document?.hasNote && <NoteMarker />}
              {item.badge}
              {item.subtitle && <span className={styles.mobileMeta}>{item.subtitle}</span>}
            </span>
          </span>
          {columns.map((column) => (
            <span key={column.id} className={`${styles.cell} ${styles.metaCell}`} style={{ textAlign: column.align }}>
              {item.cells?.[column.id]}
            </span>
          ))}
          {actionsFor(item)}
        </li>
      ))}
    </ul>
  );
}

export default FileBrowser;
