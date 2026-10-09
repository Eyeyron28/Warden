import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DownloadSimple, Eye, Images, PencilSimple, ShareNetwork, Trash } from '@phosphor-icons/react';

import FileBrowser, { SelectAllCheckbox, focusBrowserItem } from '../components/FileBrowser.jsx';
import FilePreview from '../components/FilePreview.jsx';
import ContextMenu from '../components/ContextMenu.jsx';
import SelectionBar from '../components/SelectionBar.jsx';
import { useShell } from '../components/ShellContext.js';
import ShareModal from '../components/ShareModal.jsx';
import EditDocumentModal from '../components/EditDocumentModal.jsx';
import dropdownStyles from '../components/DropdownMenu.module.css';
import { deleteDocument, downloadBytes, fetchDocumentBytes, listPhotos } from '../services/documentsService.js';
import { extractErrorMessage } from '../services/api.js';
import { formatDate } from '../utils/formatDate.js';
import { formatBytes, groupByMonth } from '../utils/listing.js';
import { useSelection } from '../utils/useSelection.js';
import { getViewPrefs, setViewPref } from '../utils/viewPrefs.js';
import { usePageMeta } from '../utils/usePageMeta.js';
import styles from './FilePages.module.css';

const isSessionExpired = (err) => err?.response?.status === 401;

/**
 * Photos: every image in the vault, from all folders, newest first and
 * grouped by month. What counts as an image is decided by the file's BYTES
 * (png, jpeg, gif, webp) - a renamed text file does not appear, a photo
 * with a wrong name does. Older files are classified a few at a time, so the
 * page asks again while the server reports some still pending.
 */
function PhotosPage() {
  usePageMeta('Photos', 'Your photos.');
  const navigate = useNavigate();
  const { showToast, refreshSidebar } = useShell();
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [order, setOrder] = useState(() => (getViewPrefs().sort === 'oldest' ? 'oldest' : 'newest'));
  const [previewIndex, setPreviewIndex] = useState(null);
  const [sharing, setSharing] = useState(null);
  const [editing, setEditing] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);

  const load = useCallback(async (isCancelled = () => false) => {
    setError('');
    try {
      let result = await listPhotos();
      let guard = 0;
      while (!isCancelled()) {
        setPhotos(result.photos);
        setPending(result.pending);
        setLoading(false);
        if (result.pending <= 0 || guard >= 300) break;
        guard += 1;
        // eslint-disable-next-line no-await-in-loop
        result = await listPhotos();
      }
    } catch (err) {
      if (!isSessionExpired(err)) setError(extractErrorMessage(err, 'Could not load your photos.'));
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  const ordered = useMemo(() => (order === 'oldest' ? [...photos].reverse() : photos), [photos, order]);
  const groups = useMemo(
    () =>
      groupByMonth(ordered).map((group) => ({
        ...group,
        items: group.items.map((doc) => ({
          key: `file:${doc.id}`,
          kind: 'file',
          id: doc.id,
          name: doc.filename,
          document: doc,
          thumbDocument: doc,
          subtitle: `${formatDate(doc.createdAt)} · ${formatBytes(doc.size)}`,
        })),
      })),
    [ordered]
  );
  const allItems = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const selection = useSelection(useMemo(() => allItems.map((item) => item.key), [allItems]));
  const files = useMemo(() => allItems.map((item) => item.document), [allItems]);
  const selectedDocs = useMemo(() => allItems.filter((item) => selection.isSelected(item.key)).map((item) => item.document), [allItems, selection]);

  const changeOrder = (next) => {
    setOrder(next);
    setViewPref('sort', next);
  };

  const closePreview = useCallback((doc) => {
    setPreviewIndex(null);
    if (doc) setTimeout(() => focusBrowserItem(`file:${doc.id}`), 0);
  }, []);

  const trashDocs = async (docs) => {
    setActionError('');
    setBusy(true);
    const results = await Promise.allSettled(docs.map((doc) => deleteDocument(doc.id)));
    const movedIds = new Set(docs.filter((_, index) => results[index].status === 'fulfilled').map((doc) => doc.id));
    const failed = docs.length - movedIds.size;
    setPhotos((prev) => prev.filter((doc) => !movedIds.has(doc.id)));
    selection.clear();
    if (movedIds.size > 0) {
      showToast(`Moved ${movedIds.size} photo${movedIds.size === 1 ? '' : 's'} to Trash`);
      refreshSidebar();
    }
    if (failed > 0) setActionError(`Could not move ${failed} photo${failed === 1 ? '' : 's'} to Trash.`);
    setBusy(false);
  };

  const handleTrashFromPreview = async (doc) => {
    await deleteDocument(doc.id);
    setPhotos((prev) => prev.filter((entry) => entry.id !== doc.id));
    showToast(`Moved "${doc.filename}" to Trash`);
    refreshSidebar();
    if (files.length <= 1) setPreviewIndex(null);
    else setPreviewIndex((index) => Math.min(index ?? 0, files.length - 2));
  };

  const handleDownloadPhotos = async (docs) => {
    setActionError('');
    setBusy(true);
    try {
      for (const doc of docs) {
        // eslint-disable-next-line no-await-in-loop
        const { bytes, filename } = await fetchDocumentBytes(doc.id, { purpose: 'download' });
        downloadBytes(bytes, filename);
        // eslint-disable-next-line no-await-in-loop
        if (docs.length > 1) await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } catch (err) {
      if (!isSessionExpired(err)) setActionError(extractErrorMessage(err, 'Download failed.'));
    } finally {
      setBusy(false);
    }
  };

  const openItem = (item) => {
    const index = allItems.findIndex((entry) => entry.key === item.key);
    if (index !== -1) setPreviewIndex(index);
  };

  const icon = (Icon) => <Icon size={18} weight="light" className={dropdownStyles.optionIcon} />;
  const menuFor = (item) => [
    { label: 'Open / Preview', icon: icon(Eye), onSelect: () => openItem(item) },
    { label: 'Download', icon: icon(DownloadSimple), onSelect: () => handleDownloadPhotos([item.document]) },
    { label: 'Share', icon: icon(ShareNetwork), onSelect: () => setSharing({ documentIds: [item.id], title: `Share "${item.name}"` }) },
    { label: 'Rename', icon: icon(PencilSimple), onSelect: () => setEditing(item.document) },
    { label: 'Move to trash', danger: true, icon: icon(Trash), onSelect: () => trashDocs([item.document]) },
  ];

  const actions = [
    { key: 'download', label: 'Download', icon: <DownloadSimple size={18} />, onClick: () => handleDownloadPhotos(selectedDocs), disabled: busy },
    {
      key: 'share',
      label: 'Share',
      icon: <ShareNetwork size={18} />,
      onClick: () =>
        setSharing({
          documentIds: selectedDocs.map((doc) => doc.id),
          title: selectedDocs.length === 1 ? `Share "${selectedDocs[0].filename}"` : `Share ${selectedDocs.length} photos`,
        }),
      disabled: busy,
    },
    { key: 'trash', label: 'Move to trash', icon: <Trash size={18} />, onClick: () => trashDocs(selectedDocs), disabled: busy, danger: true },
  ];


  // Right-click, long-press or Shift+F10 on an item. An unselected item becomes the selection;
  // with several selected, the menu holds the actions that apply to the selection.
  const handleItemContextMenu = (item, { x, y, opener }) => {
    const wasSelected = selection.isSelected(item.key);
    if (!wasSelected) selection.setOnly(item.key);
    const multiple = wasSelected && selection.count > 1;
    setContextMenu({
      x,
      y,
      opener,
      label: multiple ? `${selection.count} selected items` : item.name,
      items: multiple
        ? actions.map((action) => ({ label: action.label, icon: action.icon, onSelect: action.onClick, disabled: action.disabled, danger: action.danger }))
        : menuFor(item),
    });
  };

  return (
    <div className={styles.page}>
      {selection.count > 0 ? (
        <SelectionBar count={selection.count} actions={actions} onClear={selection.clear} />
      ) : (
        <div className={styles.toolbar}>
          <div className={styles.titleBlock}>
            <h1 className={styles.heading}>Photos</h1>
            <span className={styles.count}>
              {loading ? 'Loading…' : `${photos.length} photo${photos.length === 1 ? '' : 's'}`}
              {pending > 0 ? ` · sorting ${pending} more…` : ''}
            </span>
          </div>
          <div className={styles.controls}>
            {allItems.length > 0 && (
              <label className={styles.selectAll}>
                <SelectAllCheckbox header={selection.header} onChange={selection.selectAll} />
                <span className={styles.selectAllLabel}>Select all</span>
              </label>
            )}
            <select className={styles.sort} value={order} onChange={(event) => changeOrder(event.target.value)} aria-label="Sort by">
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
            </select>
          </div>
        </div>
      )}

      {actionError && <p className={styles.banner} role="alert">{actionError}</p>}
      {error && <p className={styles.banner} role="alert">{error}</p>}

      {!loading && !error && photos.length === 0 && pending === 0 && (
        <div className={styles.empty}>
          <Images size={22} weight="light" className={styles.emptyIcon} />
          <span>No photos yet. Images you upload (PNG, JPEG, GIF, WebP) show up here.</span>
          <button type="button" className={styles.secondaryButton} onClick={() => navigate('/files')}>
            Go to My files
          </button>
        </div>
      )}

      {groups.map((group) => (
        <section key={group.key} aria-label={group.label}>
          <h2 className={styles.monthHeading}>{group.label}</h2>
          <FileBrowser items={group.items} view="grid" selection={selection} onOpen={openItem} menuFor={menuFor} onItemContextMenu={handleItemContextMenu} label={group.label} />
        </section>
      ))}

      {previewIndex !== null && files.length > 0 && (
        <FilePreview
          files={files}
          index={Math.min(previewIndex, files.length - 1)}
          onIndexChange={setPreviewIndex}
          onClose={closePreview}
          onShare={(doc) => setSharing({ documentIds: [doc.id], title: `Share "${doc.filename}"` })}
          onRename={setEditing}
          onTrash={handleTrashFromPreview}
        />
      )}


      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          label={contextMenu.label}
          returnFocus={contextMenu.opener}
          onClose={() => setContextMenu(null)}
        />
      )}

      {sharing && (
        <ShareModal
          key={sharing.documentIds.join(',')}
          documentIds={sharing.documentIds}
          title={sharing.title}
          onClose={() => setSharing(null)}
        />
      )}

      {editing && (
        <EditDocumentModal
          document={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => setPhotos((prev) => prev.map((doc) => (doc.id === updated.id ? { ...doc, ...updated } : doc)))}
        />
      )}
    </div>
  );
}

export default PhotosPage;
