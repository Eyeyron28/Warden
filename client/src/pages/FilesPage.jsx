import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowsOutCardinal,
  DownloadSimple,
  FolderLock,
  PencilSimple,
  Rows,
  ShareNetwork,
  SquaresFour,
  Trash,
  UploadSimple,
} from '@phosphor-icons/react';

import FileBrowser, { SelectAllCheckbox, focusBrowserItem } from '../components/FileBrowser.jsx';
import FilePreview from '../components/FilePreview.jsx';
import SelectionBar from '../components/SelectionBar.jsx';
import { useShell } from '../components/ShellContext.js';
import UploadForm from '../components/UploadForm.jsx';
import NewMenu from '../components/NewMenu.jsx';
import NewFolderModal from '../components/NewFolderModal.jsx';
import BackupPanel from '../components/BackupPanel.jsx';
import PreviewsPanel from '../components/PreviewsPanel.jsx';
import RestorePanel from '../components/RestorePanel.jsx';
import Modal from '../components/Modal.jsx';
import PairDevicePanel from '../components/PairDevicePanel.jsx';
import PairedDevicesPanel from '../components/PairedDevicesPanel.jsx';
import ShareModal from '../components/ShareModal.jsx';
import EditDocumentModal from '../components/EditDocumentModal.jsx';
import FolderBreadcrumb from '../components/FolderBreadcrumb.jsx';
import MoveModal from '../components/MoveModal.jsx';
import RenameFolderModal from '../components/RenameFolderModal.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import dropdownStyles from '../components/DropdownMenu.module.css';
import {
  listDocuments,
  uploadDocument,
  putThumbnail,
  deleteDocument,
  deleteFolder,
  downloadBytes,
  fetchDocumentBytes,
  listFolders,
  moveItems,
} from '../services/documentsService.js';
import { getBackupStatus, exportBackup, importBackup } from '../services/backupService.js';
import { extractErrorMessage } from '../services/api.js';
import { invalidateThumbnail } from '../services/thumbnailCache.js';
import { generateThumbnail } from '../utils/thumbnail.js';
import { formatDate, formatDateTime } from '../utils/formatDate.js';
import { SORT_OPTIONS, formatBytes, sortItems } from '../utils/listing.js';
import { useSelection } from '../utils/useSelection.js';
import { getViewPrefs, setViewPref } from '../utils/viewPrefs.js';
import { usePageMeta } from '../utils/usePageMeta.js';
import {
  normalizeFolderPath,
  splitPath,
  joinPath,
  getImmediateChildren,
  relativeDirFromPath,
  combineFolderPath,
  pathStillExists,
} from '../utils/folderPath.js';
import styles from './FilePages.module.css';

// A 401 mid-request means the session just expired - the axios interceptor
// already clears it, and the route guard is about to unmount this page.
const isSessionExpired = (err) => err?.response?.status === 401;

const PANELS = ['backup', 'restore', 'previews', 'pair', 'devices'];

const expiryLabel = (days) => (days === 0 ? 'Expires today' : `Expires in ${days} day${days === 1 ? '' : 's'}`);

const FILE_COLUMNS = [
  { id: 'modified', label: 'Modified', width: '120px' },
  { id: 'size', label: 'Size', width: '76px', align: 'right' },
  { id: 'shared', label: 'Shared', width: '64px' },
];

/**
 * My files: the folder you are in (`?path=`), as a list or grid. Clicking a
 * file opens its preview and clicking a folder opens it - nothing downloads
 * unless you use a Download button or menu item. Checkboxes appear on hover
 * and the header turns into a selection toolbar once anything is selected.
 */
function FilesPage() {
  usePageMeta('My files', 'Your documents.');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { searchTerm, showToast, refreshSidebar } = useShell();

  const currentPath = normalizeFolderPath(params.get('path') || '');
  const panel = PANELS.includes(params.get('panel')) ? params.get('panel') : null;

  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [folders, setFolders] = useState([]);

  const [view, setView] = useState(() => getViewPrefs().view);
  const [sort, setSort] = useState(() => getViewPrefs().sort);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState('');
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [folderUploadOpen, setFolderUploadOpen] = useState(false);
  const [folderUploadCount, setFolderUploadCount] = useState(0);

  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingDocument, setEditingDocument] = useState(null);
  const [moveState, setMoveState] = useState(null);
  const [renamingPath, setRenamingPath] = useState(null);
  const [sharingSelection, setSharingSelection] = useState(null);
  const [previewIndex, setPreviewIndex] = useState(null);

  const [backupStatus, setBackupStatus] = useState(null);
  const [backupSubmitting, setBackupSubmitting] = useState(false);
  const [backupError, setBackupError] = useState('');
  const [backupResult, setBackupResult] = useState(null);
  const [restoreSubmitting, setRestoreSubmitting] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [restoreResult, setRestoreResult] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setListError('');
    try {
      setDocuments(await listDocuments());
    } catch (err) {
      if (!isSessionExpired(err)) setListError(extractErrorMessage(err, 'Could not load your documents.'));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshFolders = useCallback(async () => {
    try {
      setFolders(await listFolders());
    } catch {
      // The folder list is a convenience; a failed fetch leaves the tree as it was.
    }
    refreshSidebar();
  }, [refreshSidebar]);

  const refreshBackupStatus = useCallback(async () => {
    try {
      setBackupStatus(await getBackupStatus());
    } catch {
      // Informational only.
    }
  }, []);

  useEffect(() => {
    refresh();
    refreshBackupStatus();
    refreshFolders();
  }, [refresh, refreshBackupStatus, refreshFolders]);

  const setCurrentPath = useCallback(
    (path, { replace = false } = {}) => {
      navigate(path ? `/files?path=${encodeURIComponent(path)}` : '/files', { replace });
    },
    [navigate]
  );

  // A folder that no longer exists (its last file moved, or it was trashed)
  // takes you to the top level rather than an empty view with no way out.
  useEffect(() => {
    if (loading || currentPath === '') return;
    const documentFolders = documents.map((doc) => normalizeFolderPath(doc.folder));
    const folderNames = folders.map((name) => normalizeFolderPath(name));
    if (!pathStillExists(currentPath, documentFolders, folderNames)) setCurrentPath('', { replace: true });
  }, [loading, documents, folders, currentPath, setCurrentPath]);

  const setViewMode = (next) => {
    setView(next);
    setViewPref('view', next);
  };
  const changeSort = (next) => {
    setSort(next);
    setViewPref('sort', next);
  };

  // ---- what is shown ----
  const normalizedSearch = searchTerm.trim().toLowerCase();
  const isSearching = normalizedSearch.length > 0;

  const visibleDocuments = useMemo(() => {
    if (isSearching) return documents.filter((doc) => doc.filename.toLowerCase().includes(normalizedSearch));
    return documents.filter((doc) => normalizeFolderPath(doc.folder) === currentPath);
  }, [documents, currentPath, isSearching, normalizedSearch]);

  const subfolderNames = useMemo(() => {
    if (isSearching) return [];
    const allPaths = new Set();
    for (const doc of documents) {
      const path = normalizeFolderPath(doc.folder);
      if (path) allPaths.add(path);
    }
    for (const name of folders) {
      const path = normalizeFolderPath(name);
      if (path) allPaths.add(path);
    }
    return getImmediateChildren(allPaths, currentPath);
  }, [documents, folders, currentPath, isSearching]);

  const items = useMemo(() => {
    const folderItems = subfolderNames.map((name) => {
      const path = joinPath([...splitPath(currentPath), name]);
      const prefix = `${path}/`;
      const count = documents.filter((doc) => {
        const docPath = normalizeFolderPath(doc.folder);
        return docPath === path || docPath.startsWith(prefix);
      }).length;
      const label = `${count} item${count === 1 ? '' : 's'}`;
      return {
        key: `folder:${path}`,
        kind: 'folder',
        path,
        name,
        subtitle: label,
        cells: { modified: '—', size: label },
      };
    });
    const fileItems = visibleDocuments.map((doc) => {
      const modified = doc.updatedAt || doc.createdAt;
      const where = isSearching && normalizeFolderPath(doc.folder) ? ` · ${normalizeFolderPath(doc.folder)}` : '';
      return {
        key: `file:${doc.id}`,
        kind: 'file',
        id: doc.id,
        name: doc.filename,
        size: doc.size ?? 0,
        modified,
        document: doc,
        thumbDocument: doc,
        subtitle: `${formatDate(modified)} · ${formatBytes(doc.size)}${where}`,
        badge:
          doc.expiryStatus === 'expired' ? (
            <StatusBadge label="Expired" tone="danger" />
          ) : doc.expiryStatus === 'expiring_soon' ? (
            <StatusBadge label={expiryLabel(doc.daysUntilExpiry)} tone="warning" />
          ) : null,
        cells: {
          modified: formatDate(modified),
          size: formatBytes(doc.size),
          shared: doc.shared ? 'Shared' : '',
        },
      };
    });
    return sortItems([...folderItems, ...fileItems], sort);
  }, [subfolderNames, visibleDocuments, documents, currentPath, sort, isSearching]);

  const orderedKeys = useMemo(() => items.map((item) => item.key), [items]);
  const selection = useSelection(orderedKeys);
  const fileItems = useMemo(() => items.filter((item) => item.kind === 'file'), [items]);
  const previewFiles = useMemo(() => fileItems.map((item) => item.document), [fileItems]);

  const vaultIsEmpty = documents.length === 0 && !folders.some((name) => normalizeFolderPath(name));

  // ---- uploads ----
  const handleUpload = async ({ file, expiryDate }) => {
    setUploading(true);
    setUploadProgress(0);
    setUploadError('');
    try {
      await uploadDocument({ file, folder: currentPath || undefined, expiryDate }, setUploadProgress);
      setUploadOpen(false);
      await refresh();
      refreshFolders();
    } catch (err) {
      setUploadError(extractErrorMessage(err, 'Upload failed.'));
    } finally {
      setUploading(false);
    }
  };

  const handleUploadFolder = async (fileList) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    setUploadOpen(false);
    setFolderUploadOpen(true);
    setFolderUploadCount(0);
    setUploading(true);
    setUploadProgress(0);
    setUploadError('');
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const relativeDir = relativeDirFromPath(file.webkitRelativePath || file.name);
        const folder = combineFolderPath(currentPath, relativeDir);
        // eslint-disable-next-line no-await-in-loop
        await uploadDocument({ file, folder }, (filePercent) => {
          setUploadProgress(Math.round(((index + filePercent / 100) / files.length) * 100));
        });
      }
      setFolderUploadCount(files.length);
      await refresh();
      refreshFolders();
    } catch (err) {
      setUploadError(extractErrorMessage(err, 'Folder upload failed.'));
    } finally {
      setUploading(false);
    }
  };

  // ---- thumbnails ----
  const markThumbnailAdded = useCallback((id) => {
    invalidateThumbnail(id);
    setDocuments((prev) => prev.map((doc) => (doc.id === id ? { ...doc, hasThumb: true } : doc)));
  }, []);

  // The preview just decrypted this file: if it has no thumbnail yet, draw one
  // from those same bytes. Silent and best-effort.
  const backfillThumbnail = useCallback(
    async (doc, bytes, sniff) => {
      if (!doc || doc.hasThumb || !sniff.mime || !/^(image\/|application\/pdf)/.test(sniff.mime)) return;
      try {
        const thumb = await generateThumbnail(new Blob([bytes], { type: sniff.mime }), { name: doc.filename });
        if (!thumb) return;
        await putThumbnail(doc.id, thumb);
        markThumbnailAdded(doc.id);
      } catch {
        // The file just keeps its type icon.
      }
    },
    [markThumbnailAdded]
  );

  // ---- opening, trashing, downloading ----
  const openItem = (item) => {
    if (item.kind === 'folder') {
      setCurrentPath(item.path);
      return;
    }
    const index = fileItems.findIndex((entry) => entry.key === item.key);
    if (index !== -1) setPreviewIndex(index);
  };

  const closePreview = useCallback((doc) => {
    setPreviewIndex(null);
    if (doc) setTimeout(() => focusBrowserItem(`file:${doc.id}`), 0);
  }, []);

  const trashOne = async (doc) => {
    await deleteDocument(doc.id);
    setDocuments((prev) => prev.filter((entry) => entry.id !== doc.id));
    showToast(`Moved "${doc.filename}" to Trash`);
    refreshFolders();
  };

  const handleTrashFromMenu = async (doc) => {
    setActionError('');
    try {
      await trashOne(doc);
    } catch (err) {
      if (!isSessionExpired(err)) setActionError(extractErrorMessage(err, 'Could not move this file to Trash.'));
    }
  };

  const handleTrashFromPreview = async (doc) => {
    await trashOne(doc);
    if (previewFiles.length <= 1) setPreviewIndex(null);
    else setPreviewIndex((index) => Math.min(index ?? 0, previewFiles.length - 2));
  };

  const handleTrashFolderFromMenu = async (item) => {
    setActionError('');
    try {
      await deleteFolder(item.path);
      showToast(`Moved folder "${item.name}" to Trash`);
      await refresh();
      refreshFolders();
    } catch (err) {
      if (!isSessionExpired(err)) setActionError(extractErrorMessage(err, 'Could not move this folder to Trash.'));
    }
  };

  const handleDownloadFiles = async (docs) => {
    setActionError('');
    setBusy(true);
    try {
      for (const doc of docs) {
        // eslint-disable-next-line no-await-in-loop
        const { bytes } = await fetchDocumentBytes(doc.id);
        downloadBytes(bytes, doc.filename);
        // eslint-disable-next-line no-await-in-loop
        if (docs.length > 1) await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } catch (err) {
      if (!isSessionExpired(err)) setActionError(extractErrorMessage(err, 'Download failed.'));
    } finally {
      setBusy(false);
    }
  };

  // ---- the selection ----
  const selectedFolderPaths = useMemo(
    () => items.filter((item) => item.kind === 'folder' && selection.isSelected(item.key)).map((item) => item.path),
    [items, selection]
  );
  const selectedFiles = useMemo(
    () => fileItems.filter((item) => selection.isSelected(item.key)).map((item) => item.document),
    [fileItems, selection]
  );

  // Selected files, plus every file nested anywhere under a selected folder.
  const resolveSelection = () => {
    const nestedIds = new Set();
    for (const doc of documents) {
      const path = normalizeFolderPath(doc.folder);
      if (selectedFolderPaths.some((folder) => path === folder || path.startsWith(`${folder}/`))) nestedIds.add(doc.id);
    }
    const allIds = new Set([...selectedFiles.map((doc) => doc.id), ...nestedIds]);
    return { documentIds: [...allIds], looseIds: selectedFiles.filter((doc) => !nestedIds.has(doc.id)).map((doc) => doc.id) };
  };

  const handleBulkTrash = async () => {
    setActionError('');
    setBusy(true);
    const plan = resolveSelection();
    // allSettled: one failure must not undo the rest.
    const fileResults = await Promise.allSettled(plan.looseIds.map((id) => deleteDocument(id)));
    const folderResults = await Promise.allSettled(selectedFolderPaths.map((path) => deleteFolder(path)));
    const failed = [...fileResults, ...folderResults].filter((result) => result.status === 'rejected').length;
    const moved = plan.looseIds.length + selectedFolderPaths.length - failed;
    selection.clear();
    await refresh();
    refreshFolders();
    if (moved > 0) showToast(`Moved ${moved} item${moved === 1 ? '' : 's'} to Trash`);
    if (failed > 0) setActionError(`Could not move ${failed} item${failed === 1 ? '' : 's'} to Trash.`);
    setBusy(false);
  };

  const handleBulkShare = () => {
    const plan = resolveSelection();
    if (plan.documentIds.length === 0) return;
    if (plan.documentIds.length === 1 && selectedFolderPaths.length === 0) {
      const doc = documents.find((item) => item.id === plan.documentIds[0]);
      if (doc) setSharingSelection({ documentIds: [doc.id], title: `Share "${doc.filename}"` });
      return;
    }
    setSharingSelection({ documentIds: plan.documentIds, title: `Share ${plan.documentIds.length} files` });
  };

  // ---- moving and renaming ----
  const followRenamedPath = (oldPath, newPath) => {
    if (currentPath === oldPath) setCurrentPath(newPath, { replace: true });
    else if (currentPath.startsWith(`${oldPath}/`)) setCurrentPath(newPath + currentPath.slice(oldPath.length), { replace: true });
  };

  const openMoveForDocument = (doc) => {
    setEditingDocument(null);
    setMoveState({
      items: [{ type: 'file', id: doc.id }],
      title: `Move "${doc.filename}"`,
      currentLocation: normalizeFolderPath(doc.folder),
      movingFolders: [],
      fromSelection: false,
    });
  };

  const openMoveForFolder = (path) => {
    setMoveState({
      items: [{ type: 'folder', path }],
      title: `Move "${path.split('/').pop()}"`,
      currentLocation: splitPath(path).slice(0, -1).join('/'),
      movingFolders: [path],
      fromSelection: false,
    });
  };

  const openMoveForSelection = () => {
    const total = selectedFolderPaths.length + selectedFiles.length;
    if (total === 0) return;
    const parents = new Set([
      ...selectedFiles.map((doc) => normalizeFolderPath(doc.folder)),
      ...selectedFolderPaths.map((path) => splitPath(path).slice(0, -1).join('/')),
    ]);
    setMoveState({
      items: [
        ...selectedFiles.map((doc) => ({ type: 'file', id: doc.id })),
        ...selectedFolderPaths.map((path) => ({ type: 'folder', path })),
      ],
      title: `Move ${total} item${total === 1 ? '' : 's'}`,
      currentLocation: parents.size === 1 ? [...parents][0] : null,
      movingFolders: selectedFolderPaths,
      fromSelection: true,
    });
  };

  const handleMoved = async (response, { close }) => {
    for (const entry of response.results) {
      if (entry.type === 'folder' && entry.status === 'moved' && entry.newPath) followRenamedPath(entry.path, entry.newPath);
    }
    if (response.movedCount > 0) {
      showToast(`Moved ${response.movedCount} item${response.movedCount === 1 ? '' : 's'} to ${response.destination || 'My files'}`);
    }
    if (close) {
      if (moveState?.fromSelection) selection.clear();
      setMoveState(null);
    }
    await refresh();
    refreshFolders();
  };

  const closeMoveModal = () => {
    if (moveState?.fromSelection) selection.clear();
    setMoveState(null);
  };

  const handleRenamed = async (oldPath, newPath) => {
    followRenamedPath(oldPath, newPath);
    showToast(`Renamed to "${newPath.split('/').pop()}"`);
    await refresh();
    refreshFolders();
  };

  const handleDropDocument = async (documentId, folderItem) => {
    setActionError('');
    try {
      const response = await moveItems([{ type: 'file', id: documentId }], folderItem.path);
      const entry = response.results[0];
      if (entry.status === 'moved') {
        showToast(`Moved "${entry.name}" to ${response.destination || 'My files'}`);
        await refresh();
        refreshFolders();
      } else if (entry.status !== 'unchanged') {
        setActionError(entry.message || 'Could not move this document.');
      }
    } catch (err) {
      if (!isSessionExpired(err)) setActionError(extractErrorMessage(err, 'Could not move this document.'));
    }
  };

  const handleEditSaved = (updated) => {
    setDocuments((prev) => prev.map((doc) => (doc.id === updated.id ? { ...doc, ...updated } : doc)));
    refreshFolders();
  };

  // ---- panels (?panel=backup etc., linked from the sidebar) ----
  const closePanel = () => {
    const next = new URLSearchParams(params);
    next.delete('panel');
    setParams(next, { replace: true });
  };
  const closeBackup = () => {
    closePanel();
    setBackupError('');
    setBackupResult(null);
  };
  const closeRestore = () => {
    closePanel();
    setRestoreError('');
    setRestoreResult(null);
  };

  const handleBackupExport = async (targetPath, usbPassphrase) => {
    setBackupSubmitting(true);
    setBackupError('');
    try {
      const result = await exportBackup(targetPath, usbPassphrase);
      setBackupResult(result);
      setBackupStatus({ lastBackupAt: result.timestamp, documentCount: result.documentsBackedUp, backupPath: result.backupPath });
    } catch (err) {
      setBackupError(extractErrorMessage(err, 'Backup failed.'));
    } finally {
      setBackupSubmitting(false);
    }
  };

  const handleRestoreImport = async (sourcePath) => {
    setRestoreSubmitting(true);
    setRestoreError('');
    try {
      setRestoreResult(await importBackup(sourcePath));
      await refresh();
      refreshFolders();
    } catch (err) {
      setRestoreError(extractErrorMessage(err, 'Restore failed.'));
    } finally {
      setRestoreSubmitting(false);
    }
  };

  // ---- menus ----
  const menuFor = (item) => {
    if (item.kind === 'folder') {
      return [
        { label: 'Rename', icon: <PencilSimple size={18} weight="light" className={dropdownStyles.optionIcon} />, onSelect: () => setRenamingPath(item.path) },
        { label: 'Move to…', icon: <ArrowsOutCardinal size={18} weight="light" className={dropdownStyles.optionIcon} />, onSelect: () => openMoveForFolder(item.path) },
        { label: 'Move to trash', danger: true, icon: <Trash size={18} weight="light" className={dropdownStyles.optionIcon} />, onSelect: () => handleTrashFolderFromMenu(item) },
      ];
    }
    const doc = item.document;
    return [
      { label: 'Download', icon: <DownloadSimple size={18} weight="light" className={dropdownStyles.optionIcon} />, onSelect: () => handleDownloadFiles([doc]) },
      { label: 'Share', icon: <ShareNetwork size={18} weight="light" className={dropdownStyles.optionIcon} />, onSelect: () => setSharingSelection({ documentIds: [doc.id], title: `Share "${doc.filename}"` }) },
      { label: 'Rename', icon: <PencilSimple size={18} weight="light" className={dropdownStyles.optionIcon} />, onSelect: () => setEditingDocument(doc) },
      { label: 'Move to…', icon: <ArrowsOutCardinal size={18} weight="light" className={dropdownStyles.optionIcon} />, onSelect: () => openMoveForDocument(doc) },
      { label: 'Move to trash', danger: true, icon: <Trash size={18} weight="light" className={dropdownStyles.optionIcon} />, onSelect: () => handleTrashFromMenu(doc) },
    ];
  };

  const selectionActions = [
    {
      key: 'download',
      label: 'Download',
      icon: <DownloadSimple size={18} />,
      onClick: () => handleDownloadFiles(selectedFiles),
      disabled: busy || selectedFiles.length === 0 || selectedFolderPaths.length > 0,
      title: selectedFolderPaths.length > 0 ? 'Folders can’t be downloaded: select only files' : undefined,
    },
    { key: 'share', label: 'Share', icon: <ShareNetwork size={18} />, onClick: handleBulkShare, disabled: busy },
    { key: 'move', label: 'Move', icon: <ArrowsOutCardinal size={18} />, onClick: openMoveForSelection, disabled: busy },
    { key: 'trash', label: 'Move to trash', icon: <Trash size={18} />, onClick: handleBulkTrash, disabled: busy, danger: true },
  ];

  const backupStatusLine = backupStatus?.lastBackupAt
    ? `Last backup: ${formatDateTime(backupStatus.lastBackupAt)} · ${backupStatus.documentCount} document${backupStatus.documentCount === 1 ? '' : 's'}`
    : '';

  const emptyHere = !loading && !vaultIsEmpty && items.length === 0;

  return (
    <div className={styles.page}>
      {selection.count > 0 ? (
        <SelectionBar count={selection.count} actions={selectionActions} onClear={selection.clear} />
      ) : (
        <div className={styles.toolbar}>
          <div className={styles.titleBlock}>
            {isSearching ? (
              <h1 className={styles.heading}>Results for “{searchTerm.trim()}”</h1>
            ) : (
              <FolderBreadcrumb path={currentPath} onNavigate={setCurrentPath} />
            )}
            <span className={styles.count}>
              {loading ? 'Loading…' : `${documents.length} document${documents.length === 1 ? '' : 's'}`}
            </span>
          </div>
          <div className={styles.controls}>
            {view === 'grid' && items.length > 0 && (
              <label className={styles.selectAll}>
                <SelectAllCheckbox header={selection.header} onChange={selection.selectAll} />
                <span className={styles.selectAllLabel}>Select all</span>
              </label>
            )}
            <select className={styles.sort} value={sort} onChange={(event) => changeSort(event.target.value)} aria-label="Sort by">
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
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
            <NewMenu
              onOpenNewFolder={() => setNewFolderOpen(true)}
              onOpenUploadForm={() => setUploadOpen(true)}
              onFolderFilesSelected={handleUploadFolder}
            />
          </div>
        </div>
      )}

      {backupStatusLine && selection.count === 0 && <p className={styles.retention}>{backupStatusLine}</p>}
      {actionError && <p className={styles.banner} role="alert">{actionError}</p>}
      {listError && <p className={styles.banner} role="alert">{listError}</p>}

      {!loading && vaultIsEmpty && !listError && (
        <div className={styles.empty}>
          <FolderLock size={22} weight="light" className={styles.emptyIcon} />
          <span>Your vault is empty.</span>
          <button type="button" className={styles.primaryButton} onClick={() => setUploadOpen(true)}>
            <UploadSimple size={16} weight="bold" />
            Upload a file
          </button>
        </div>
      )}

      {emptyHere && (
        <div className={styles.empty}>
          <FolderLock size={22} weight="light" className={styles.emptyIcon} />
          <span>{isSearching ? 'No files match your search.' : 'This folder is empty.'}</span>
          {!isSearching && (
            <button type="button" className={styles.secondaryButton} onClick={() => setUploadOpen(true)}>
              <UploadSimple size={16} weight="bold" />
              Upload here
            </button>
          )}
        </div>
      )}

      {items.length > 0 && (
        <FileBrowser
          items={items}
          view={view}
          selection={selection}
          onOpen={openItem}
          columns={FILE_COLUMNS}
          menuFor={menuFor}
          onDropOnFolder={handleDropDocument}
          label="Files and folders"
        />
      )}

      {previewIndex !== null && previewFiles.length > 0 && (
        <FilePreview
          files={previewFiles}
          index={Math.min(previewIndex, previewFiles.length - 1)}
          onIndexChange={setPreviewIndex}
          onClose={closePreview}
          onShare={(doc) => setSharingSelection({ documentIds: [doc.id], title: `Share "${doc.filename}"` })}
          onRename={setEditingDocument}
          onTrash={handleTrashFromPreview}
          onLoaded={backfillThumbnail}
        />
      )}

      {uploadOpen && (
        <Modal
          title="Upload file"
          onClose={() => {
            if (uploading) return;
            setUploadOpen(false);
            setUploadError('');
          }}
        >
          <UploadForm
            onSubmit={handleUpload}
            onCancel={() => {
              setUploadOpen(false);
              setUploadError('');
            }}
            uploading={uploading}
            progress={uploadProgress}
            error={uploadError}
            destinationLabel={currentPath || 'My files'}
          />
        </Modal>
      )}

      {folderUploadOpen && (
        <Modal
          title="Upload folder"
          onClose={() => {
            if (uploading) return;
            setFolderUploadOpen(false);
            setUploadError('');
          }}
        >
          {uploading ? (
            <>
              <p className={styles.folderUploadLabel}>Uploading folder, {uploadProgress}%</p>
              <div className={styles.progressTrack} role="progressbar" aria-valuenow={uploadProgress} aria-valuemin={0} aria-valuemax={100}>
                <div className={styles.progressFill} style={{ width: `${uploadProgress}%` }} />
              </div>
            </>
          ) : (
            <>
              {uploadError ? (
                <p className={styles.banner} role="alert">{uploadError}</p>
              ) : (
                <p className={styles.folderUploadLabel}>
                  Uploaded {folderUploadCount} file{folderUploadCount === 1 ? '' : 's'} to {currentPath || 'My files'}.
                </p>
              )}
              <div className={styles.modalActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => {
                    setFolderUploadOpen(false);
                    setUploadError('');
                  }}
                >
                  Done
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

      {panel === 'backup' && (
        <Modal title="Backup to USB" onClose={closeBackup}>
          <BackupPanel onSubmit={handleBackupExport} onCancel={closeBackup} submitting={backupSubmitting} error={backupError} result={backupResult} />
        </Modal>
      )}
      {panel === 'previews' && (
        <Modal title="Generate previews" onClose={closePanel}>
          <PreviewsPanel documents={documents} onThumbnailAdded={markThumbnailAdded} onClose={closePanel} />
        </Modal>
      )}
      {panel === 'restore' && (
        <Modal title="Restore from backup" onClose={closeRestore}>
          <RestorePanel onSubmit={handleRestoreImport} onCancel={closeRestore} submitting={restoreSubmitting} error={restoreError} result={restoreResult} />
        </Modal>
      )}
      {panel === 'pair' && (
        <Modal title="Pair a device" onClose={closePanel}>
          <PairDevicePanel onClose={closePanel} />
        </Modal>
      )}
      {panel === 'devices' && (
        <Modal title="Paired devices" onClose={closePanel}>
          <PairedDevicesPanel />
        </Modal>
      )}

      {newFolderOpen && (
        <NewFolderModal onClose={() => setNewFolderOpen(false)} onCreated={refreshFolders} currentPath={currentPath} />
      )}

      {sharingSelection && (
        <ShareModal
          key={sharingSelection.documentIds.join(',')}
          documentIds={sharingSelection.documentIds}
          title={sharingSelection.title}
          onClose={() => {
            setSharingSelection(null);
            refresh();
          }}
        />
      )}

      {editingDocument && (
        <EditDocumentModal
          document={editingDocument}
          onClose={() => setEditingDocument(null)}
          onSaved={handleEditSaved}
          onMove={openMoveForDocument}
        />
      )}

      {moveState && (
        <MoveModal
          key={moveState.title}
          items={moveState.items}
          title={moveState.title}
          folderPaths={[...folders, ...documents.map((doc) => normalizeFolderPath(doc.folder))]}
          startPath={currentPath}
          currentLocation={moveState.currentLocation}
          movingFolders={moveState.movingFolders}
          onClose={closeMoveModal}
          onMoved={handleMoved}
          onFolderCreated={refreshFolders}
        />
      )}

      {renamingPath && <RenameFolderModal path={renamingPath} onClose={() => setRenamingPath(null)} onRenamed={handleRenamed} />}
    </div>
  );
}

export default FilesPage;
