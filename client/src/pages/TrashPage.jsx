import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUUpLeft, Rows, SquaresFour, Trash } from '@phosphor-icons/react';

import FileBrowser, { SelectAllCheckbox } from '../components/FileBrowser.jsx';
import Modal from '../components/Modal.jsx';
import SelectionBar from '../components/SelectionBar.jsx';
import { useShell } from '../components/ShellContext.js';
import dropdownStyles from '../components/DropdownMenu.module.css';
import { deleteTrashItem, emptyTrash, listTrash, restoreTrashItem } from '../services/trashService.js';
import { extractErrorMessage } from '../services/api.js';
import { formatDate } from '../utils/formatDate.js';
import { SORT_OPTIONS, formatBytes, sortItems } from '../utils/listing.js';
import { useSelection } from '../utils/useSelection.js';
import { getViewPrefs, setViewPref } from '../utils/viewPrefs.js';
import { usePageMeta } from '../utils/usePageMeta.js';
import styles from './FilePages.module.css';

const isSessionExpired = (err) => err?.response?.status === 401;

const COLUMNS = [
  { id: 'location', label: 'Original location', width: 'minmax(120px, 220px)' },
  { id: 'deleted', label: 'Deleted', width: '110px' },
  { id: 'daysLeft', label: 'Days left', width: '84px' },
  { id: 'size', label: 'Size', width: '76px', align: 'right' },
];

const placeLabel = (location) => (location ? `My files / ${location.split('/').join(' / ')}` : 'My files');
const daysLabel = (days) => `${days} day${days === 1 ? '' : 's'}`;

/**
 * Trash: what you deleted, kept encrypted for 30 days and then removed for
 * good. Restore puts an item back where it was; if that folder is gone or the
 * name is taken it goes to the top level (and says so). A deleted folder comes
 * back together with everything in it. Nothing here can be opened - restore it
 * first - so a click on a row just selects it.
 */
function TrashPage() {
  usePageMeta('Trash', 'Deleted files, kept for 30 days.');
  const { showToast, refreshSidebar } = useShell();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null); // { type: 'delete' | 'empty', items }
  const [view, setView] = useState(() => getViewPrefs().view);
  const [sort, setSort] = useState(() => getViewPrefs().sort);

  const load = useCallback(async () => {
    try {
      setData(await listTrash());
      setError('');
    } catch (err) {
      if (!isSessionExpired(err)) setError(extractErrorMessage(err, 'Could not load your Trash.'));
      setData((current) => current ?? { items: [], retentionDays: 30 });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const items = useMemo(() => {
    const rows = (data?.items ?? []).map((entry) => {
      const kind = entry.kind === 'folder' ? 'trash-folder' : 'trash-file';
      const sizeText = entry.kind === 'folder' ? `${entry.itemCount} item${entry.itemCount === 1 ? '' : 's'}` : formatBytes(entry.size);
      return {
        key: `${entry.kind}:${entry.id}`,
        kind,
        entry,
        id: entry.id,
        name: entry.name,
        size: entry.size ?? 0,
        modified: entry.deletedAt,
        // Trashed files have no preview or thumbnail to fetch: show the type icon.
        thumbDocument: entry.kind === 'file' ? { id: entry.id, filename: entry.name, hasThumb: false } : undefined,
        subtitle: `${placeLabel(entry.originalLocation)} · ${daysLabel(entry.daysLeft)} left`,
        cells: {
          location: placeLabel(entry.originalLocation),
          deleted: formatDate(entry.deletedAt),
          daysLeft: <span className={entry.daysLeft <= 3 ? styles.daysLeftSoon : styles.daysLeft}>{daysLabel(entry.daysLeft)}</span>,
          size: sizeText,
        },
      };
    });
    // Folders-first does not apply here: order purely as chosen.
    return sortItems(rows.map((row) => ({ ...row, kind: row.kind === 'trash-folder' ? 'file' : row.kind })), sort).map(
      (row) => rows.find((original) => original.key === row.key)
    );
  }, [data, sort]);

  const selection = useSelection(useMemo(() => items.map((item) => item.key), [items]));
  const selectedItems = useMemo(() => items.filter((item) => selection.isSelected(item.key)), [items, selection]);

  const setViewMode = (next) => {
    setView(next);
    setViewPref('view', next);
  };
  const changeSort = (next) => {
    setSort(next);
    setViewPref('sort', next);
  };

  const restore = async (targets) => {
    setBusy(true);
    setError('');
    setNotice('');
    const messages = [];
    const problems = [];
    let restored = 0;
    for (const target of targets) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await restoreTrashItem(target.entry.kind, target.entry.id);
        restored += 1;
        if (result.message) messages.push(`“${target.name}”: ${result.message}`);
      } catch (err) {
        if (isSessionExpired(err)) break;
        // A 409 means the top level has that name as well: the server's message says what to do.
        problems.push(`“${target.name}”: ${extractErrorMessage(err, 'Could not restore this item.')}`);
      }
    }
    selection.clear();
    await load();
    refreshSidebar();
    if (restored > 0) showToast(`Restored ${restored} item${restored === 1 ? '' : 's'}`);
    if (messages.length > 0) setNotice(messages.join(' '));
    if (problems.length > 0) setError(problems.join(' '));
    setBusy(false);
  };

  const runConfirmed = async () => {
    const request = confirm;
    setConfirm(null);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (request.type === 'empty') {
        await emptyTrash();
        showToast('Trash emptied');
      } else {
        const results = await Promise.allSettled(request.items.map((item) => deleteTrashItem(item.entry.kind, item.entry.id)));
        const failed = results.filter((result) => result.status === 'rejected').length;
        if (failed > 0) setError(`Could not delete ${failed} item${failed === 1 ? '' : 's'}.`);
        else showToast(`Permanently deleted ${request.items.length} item${request.items.length === 1 ? '' : 's'}`);
      }
    } catch (err) {
      if (!isSessionExpired(err)) setError(extractErrorMessage(err, 'Could not delete from Trash.'));
    }
    selection.clear();
    await load();
    refreshSidebar();
    setBusy(false);
  };

  const icon = (Icon) => <Icon size={18} weight="light" className={dropdownStyles.optionIcon} />;
  const menuFor = (item) => [
    { label: 'Restore', icon: icon(ArrowUUpLeft), onSelect: () => restore([item]) },
    { label: 'Delete permanently', danger: true, icon: icon(Trash), onSelect: () => setConfirm({ type: 'delete', items: [item] }) },
  ];

  const actions = [
    { key: 'restore', label: 'Restore', icon: <ArrowUUpLeft size={18} />, onClick: () => restore(selectedItems), disabled: busy },
    {
      key: 'delete',
      label: 'Delete permanently',
      icon: <Trash size={18} />,
      onClick: () => setConfirm({ type: 'delete', items: selectedItems }),
      disabled: busy,
      danger: true,
    },
  ];

  const loading = data === null;
  const total = items.length;
  const describe = (list) => (list.length === 1 ? `“${list[0].name}”` : `${list.length} items`);

  return (
    <div className={styles.page}>
      {selection.count > 0 ? (
        <SelectionBar count={selection.count} actions={actions} onClear={selection.clear} />
      ) : (
        <div className={styles.toolbar}>
          <div className={styles.titleBlock}>
            <h1 className={styles.heading}>Trash</h1>
            <span className={styles.count}>{loading ? 'Loading…' : `${total} item${total === 1 ? '' : 's'}`}</span>
          </div>
          <div className={styles.controls}>
            {view === 'grid' && total > 0 && (
              <label className={styles.selectAll}>
                <SelectAllCheckbox header={selection.header} onChange={selection.selectAll} />
                <span className={styles.selectAllLabel}>Select all</span>
              </label>
            )}
            <select className={styles.sort} value={sort} onChange={(event) => changeSort(event.target.value)} aria-label="Sort by">
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.value === 'newest' ? 'Recently deleted' : option.value === 'oldest' ? 'Deleted longest ago' : option.label}
                </option>
              ))}
            </select>
            <div className={styles.viewToggle} role="group" aria-label="View">
              <button type="button" className={styles.viewButton} onClick={() => setViewMode('list')} aria-label="List view" aria-pressed={view === 'list'}>
                <Rows size={16} weight="bold" />
              </button>
              <button type="button" className={styles.viewButton} onClick={() => setViewMode('grid')} aria-label="Grid view" aria-pressed={view === 'grid'}>
                <SquaresFour size={16} weight="bold" />
              </button>
            </div>
            <button type="button" className={styles.dangerButton} disabled={busy || total === 0} onClick={() => setConfirm({ type: 'empty' })}>
              <Trash size={16} weight="bold" />
              Empty trash
            </button>
          </div>
        </div>
      )}

      <p className={styles.retention}>
        Deleted items stay here, still encrypted, for {data?.retentionDays ?? 30} days and are then permanently removed.
      </p>

      {notice && <p className={styles.notice} role="status">{notice}</p>}
      {error && <p className={styles.banner} role="alert">{error}</p>}

      {!loading && total === 0 && !error && (
        <div className={styles.empty}>
          <Trash size={22} weight="light" className={styles.emptyIcon} />
          <span>Trash is empty.</span>
        </div>
      )}

      {total > 0 && (
        <FileBrowser items={items} view={view} selection={selection} onOpen={() => {}} columns={COLUMNS} menuFor={menuFor} label="Items in Trash" />
      )}

      {confirm && (
        <Modal title={confirm.type === 'empty' ? 'Empty Trash?' : 'Delete permanently?'} onClose={() => setConfirm(null)}>
          <p className={styles.confirmText}>
            {confirm.type === 'empty'
              ? `Permanently delete everything in Trash (${total} item${total === 1 ? '' : 's'})? `
              : `Permanently delete ${describe(confirm.items)}? `}
            The encrypted data and previews are erased and <strong>this can’t be undone</strong>.
          </p>
          <div className={styles.modalActions}>
            <button type="button" className={styles.secondaryButton} onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button type="button" className={styles.dangerButton} onClick={runConfirmed}>
              {confirm.type === 'empty' ? 'Empty trash' : 'Delete permanently'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default TrashPage;
