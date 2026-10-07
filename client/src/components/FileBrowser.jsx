import { useEffect, useRef, useState } from 'react';
import { DotsThree, Folder } from '@phosphor-icons/react';

import DocumentThumb from './DocumentThumb.jsx';
import DropdownMenu from './DropdownMenu.jsx';
import dropdownStyles from './DropdownMenu.module.css';
import { rowClickAction } from '../utils/clickAction.js';
import { DRAG_MIME, canDragDocuments } from '../utils/dragAndDrop.js';
import styles from './FileBrowser.module.css';

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
  const target = row?.querySelector('button[title], button');
  if (target) target.focus();
}

function Lead({ item }) {
  if (item.kind === 'folder' || item.kind === 'trash-folder') {
    return <Folder size={22} weight="fill" className={styles.folderIcon} aria-hidden="true" />;
  }
  return item.thumbDocument ? <DocumentThumb document={item.thumbDocument} variant="row" /> : null;
}

function ItemMenu({ item, menuItems, placeholder = false }) {
  if (!menuItems || menuItems.length === 0) return placeholder ? <span /> : null;
  return (
    <div className={styles.menu} data-no-open>
      <DropdownMenu
        align="right"
        trigger={({ toggle, open }) => (
          <button
            type="button"
            className={styles.menuButton}
            onClick={toggle}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={`More actions for ${item.name}`}
          >
            <DotsThree size={18} weight="bold" />
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
 * items: [{ key, kind: 'file'|'folder'|'trash-file'|'trash-folder', name,
 *   subtitle?, badge?, thumbDocument?, cells?: { [columnId]: node } }]
 */
function FileBrowser({
  items,
  view,
  selection,
  onOpen,
  columns = [],
  menuFor,
  onDropOnFolder,
  showListHeader = true,
  label,
}) {
  const [draggable] = useState(canDragDocuments);
  const [dropKey, setDropKey] = useState(null);
  const anySelected = selection.count > 0;

  const handleClick = (item, event) => {
    if (event.target.closest('[data-no-open]')) return;
    const action = rowClickAction(item, { shift: event.shiftKey, ctrl: event.ctrlKey, meta: event.metaKey });
    if (action === 'range') selection.click(item.key, { shift: true });
    else if (action === 'toggle') selection.click(item.key, { shift: false });
    else onOpen(item);
  };

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
    ...dropProps(item),
    ...dragProps(item),
  });

  if (view === 'grid') {
    return (
      <ul className={styles.grid} data-any-selected={anySelected || undefined} aria-label={label}>
        {items.map((item) => (
          <li key={item.key} className={styles.card} {...common(item)}>
            <div className={styles.cardThumb}>
              {item.kind === 'folder' || item.kind === 'trash-folder' ? (
                <Folder size={56} weight="fill" className={styles.folderIconLarge} aria-hidden="true" />
              ) : (
                <DocumentThumb document={item.thumbDocument} variant="fill" />
              )}
            </div>
            {checkbox(item)}
            <ItemMenu item={item} menuItems={menuFor?.(item)} />
            <div className={styles.cardBody}>
              <button type="button" className={styles.cardName} title={item.name}>
                {item.name}
              </button>
              {item.subtitle && <span className={styles.cardMeta}>{item.subtitle}</span>}
              {item.badge}
            </div>
          </li>
        ))}
      </ul>
    );
  }

  const wide = ['var(--lead)', 'minmax(0, 1fr)', ...columns.map((column) => column.width), '36px'].join(' ');
  const narrow = ['var(--lead)', 'minmax(0, 1fr)', '36px'].join(' ');
  const gridVars = { '--cols-wide': wide, '--cols-narrow': narrow };

  return (
    <ul className={styles.list} data-any-selected={anySelected || undefined} style={gridVars} aria-label={label}>
      {showListHeader && (
        <li className={`${styles.row} ${styles.headRow}`}>
          <span className={styles.lead}>
            <SelectAllCheckbox header={selection.header} onChange={() => (selection.header === 'all' ? selection.clear() : selection.selectAll())} />
          </span>
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
          <span className={styles.lead}>
            <span className={styles.leadIcon}>
              <Lead item={item} />
            </span>
            {checkbox(item)}
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
