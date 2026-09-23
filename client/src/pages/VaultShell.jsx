import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckSquare, FolderLock, Rows, ShareNetwork, SquaresFour, Trash } from '@phosphor-icons/react';

import Header from '../components/Header.jsx';
import SideNav from '../components/SideNav.jsx';
import DocumentRow from '../components/DocumentRow.jsx';
import DocumentCard from '../components/DocumentCard.jsx';
import UploadForm from '../components/UploadForm.jsx';
import NewMenu from '../components/NewMenu.jsx';
import NewFolderModal from '../components/NewFolderModal.jsx';
import BackupPanel from '../components/BackupPanel.jsx';
import RestorePanel from '../components/RestorePanel.jsx';
import Modal from '../components/Modal.jsx';
import PairDevicePanel from '../components/PairDevicePanel.jsx';
import PairedDevicesPanel from '../components/PairedDevicesPanel.jsx';
import ShareModal from '../components/ShareModal.jsx';
import EditDocumentModal from '../components/EditDocumentModal.jsx';
import FolderBreadcrumb from '../components/FolderBreadcrumb.jsx';
import FolderTile from '../components/FolderTile.jsx';
import {
  listDocuments,
  uploadDocument,
  fetchDocumentBlob,
  openBlob,
  deleteDocument,
  deleteFolder,
  listFolders,
} from '../services/documentsService.js';
import { getBackupStatus, exportBackup, importBackup } from '../services/backupService.js';
import { extractErrorMessage } from '../services/api.js';
import { formatDateTime } from '../utils/formatDate.js';
import { sortByExpiryUrgency } from '../utils/documentSort.js';
import {
  normalizeFolderPath,
  splitPath,
  joinPath,
  getImmediateChildren,
  relativeDirFromPath,
  combineFolderPath,
  pathStillExists,
} from '../utils/folderPath.js';
import styles from './VaultShell.module.css';

// A 401 mid-request means the session just expired - the axios interceptor
// already clears it, and App's route guard is about to unmount this whole
// page, so there's no point flashing an error banner for it.
const isSessionExpired = (err) => err?.response?.status === 401;

// Same breakpoint LockScreen's desktop layout and the phone-detection
// check use elsewhere in this app - collapsed by default below it,
// open by default at or above it. Computed once via useState's lazy
// initializer (same pattern as App.jsx's RootRoute phone check), so a
// later window resize never overrides a choice the person made by
// toggling the hamburger button themselves.
const DESKTOP_NAV_BREAKPOINT = '(min-width: 900px)';
function isDesktopWidth() {
  return typeof window !== 'undefined' && window.matchMedia(DESKTOP_NAV_BREAKPOINT).matches;
}

function VaultShell({ onLocked }) {
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState('');

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  // "Upload folder" picks files natively, then reports progress/result in a modal.
  const [folderUploadOpen, setFolderUploadOpen] = useState(false);
  const [folderUploadCount, setFolderUploadCount] = useState(0);

  const [viewingId, setViewingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [actionError, setActionError] = useState('');

  const [editingDocument, setEditingDocument] = useState(null);

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  // Folder tiles selected in Select mode, by full path (e.g. "PC/Projects").
  const [selectedFolders, setSelectedFolders] = useState(new Set());
  // Set when a bulk delete needs the owner's explicit confirmation: the
  // resolved plan (see resolveSelection) that the dialog describes.
  const [bulkDeletePlan, setBulkDeletePlan] = useState(null);
  const [sharingSelection, setSharingSelection] = useState(null); // { documentIds, title }
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const [folders, setFolders] = useState([]);
  // Drive-style navigable path, e.g. "" (top level) or "PC/Projects" -
  // replaces the old flat activeFolder tag/tab. See utils/folderPath.js
  // for how this is derived into a tree purely from splitting document
  // and folder-record path strings, with no separate Folder-tree model.
  const [currentPath, setCurrentPath] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [viewMode, setViewMode] = useState('list'); // 'list' | 'grid'

  const [navOpen, setNavOpen] = useState(isDesktopWidth);

  const [backupStatus, setBackupStatus] = useState(null);
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupSubmitting, setBackupSubmitting] = useState(false);
  const [backupError, setBackupError] = useState('');
  const [backupResult, setBackupResult] = useState(null);

  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreSubmitting, setRestoreSubmitting] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [restoreResult, setRestoreResult] = useState(null);

  const [pairOpen, setPairOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setListError('');
    try {
      const data = await listDocuments();
      setDocuments(sortByExpiryUrgency(data));
    } catch (err) {
      if (!isSessionExpired(err)) {
        setListError(extractErrorMessage(err, 'Could not load your documents.'));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshFolders = useCallback(async () => {
    try {
      const data = await listFolders();
      setFolders(data);
    } catch {
      // Folder list is a navigation convenience, not critical path - a
      // failed fetch just leaves the existing tree stale.
    }
  }, []);

  const refreshBackupStatus = useCallback(async () => {
    try {
      const data = await getBackupStatus();
      setBackupStatus(data);
    } catch {
      // Status is informational, not critical path - a failed fetch here
      // just means the "last backup" line stays blank rather than
      // blocking the vault view with an error banner.
    }
  }, []);

  useEffect(() => {
    refresh();
    refreshBackupStatus();
    refreshFolders();
  }, [refresh, refreshBackupStatus, refreshFolders]);

  // If the folder currently being viewed no longer resolves to anything
  // (its last document was moved/deleted elsewhere, and it had no Folder
  // record of its own), bounce back to the top level rather than silently
  // showing an empty view with no way out. Skipped while still loading -
  // both lists start empty before the first fetch resolves, and
  // currentPath is always "" until the user actually navigates.
  useEffect(() => {
    if (loading) return;
    const documentFolders = documents.map((doc) => normalizeFolderPath(doc.folder));
    const folderNames = folders.map((name) => normalizeFolderPath(name));
    if (!pathStillExists(currentPath, documentFolders, folderNames)) {
      setCurrentPath('');
    }
  }, [loading, documents, folders, currentPath]);

  // Uploads always land in currentPath - wherever VaultShell is currently
  // showing - matching Drive's own upload behavior, rather than a folder
  // typed by hand in the upload form.
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

  // "Upload folder" from the New menu - reuses the exact same
  // POST /api/documents call as a single-file upload, once per file, with
  // the folder derived from that file's own relative path prefixed with
  // currentPath (so the selected folder is filed inside wherever the
  // upload was started from, not always at the top level). No new
  // endpoint: an upload of N files is just N of the same request the
  // single-file flow already makes.
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
        const relativePath = file.webkitRelativePath || file.name;
        const relativeDir = relativeDirFromPath(relativePath);
        const folder = combineFolderPath(currentPath, relativeDir);

        await uploadDocument({ file, folder }, (filePercent) => {
          const overall = Math.round(((index + filePercent / 100) / files.length) * 100);
          setUploadProgress(overall);
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

  const handleFolderCreated = () => {
    refreshFolders();
  };

  const handleView = async (id) => {
    setActionError('');
    setViewingId(id);
    try {
      const { blob, filename } = await fetchDocumentBlob(id);
      openBlob(blob, filename);
    } catch (err) {
      if (!isSessionExpired(err)) {
        setActionError(extractErrorMessage(err, 'Could not open this document.'));
      }
    } finally {
      setViewingId(null);
    }
  };

  const handleDelete = async (id) => {
    setActionError('');
    setDeletingId(id);
    try {
      await deleteDocument(id);
      setDocuments((prev) => prev.filter((doc) => doc.id !== id));
      // Keeps the bulk-select count honest if this row's own trash icon was
      // used while that same document happened to be checked.
      setSelectedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      refreshFolders();
    } catch (err) {
      if (!isSessionExpired(err)) {
        setActionError(extractErrorMessage(err, 'Could not delete this document.'));
      }
    } finally {
      setDeletingId(null);
    }
  };

  const enterSelectMode = () => {
    setSelectMode(true);
    setSelectedIds(new Set());
    setSelectedFolders(new Set());
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setSelectedFolders(new Set());
    setBulkDeletePlan(null);
  };

  const toggleSelected = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleFolderSelected = (path) => {
    setSelectedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  // Resolves the current selection down to a flat, de-duplicated list of
  // document ids: every loose selected document, plus every document nested
  // anywhere under each selected folder (subfolders included). A loose
  // document that also lives inside a selected folder is counted once.
  // `nestedCount` is how many documents the selected folders contribute on
  // their own, for the confirmation wording.
  const resolveSelection = () => {
    const folderPaths = [...selectedFolders];
    const nestedIds = new Set();
    for (const doc of documents) {
      const path = normalizeFolderPath(doc.folder);
      if (folderPaths.some((folder) => path === folder || path.startsWith(`${folder}/`))) {
        nestedIds.add(doc.id);
      }
    }
    const allIds = new Set([...selectedIds, ...nestedIds]);
    const looseOnly = [...selectedIds].filter((id) => !nestedIds.has(id));
    return {
      folderPaths,
      documentIds: [...allIds],
      looseCount: looseOnly.length,
      nestedCount: nestedIds.size,
    };
  };

  const handleBulkDeleteClick = () => {
    if (selectedIds.size + selectedFolders.size === 0) return;
    const plan = resolveSelection();
    // Nothing to destroy except empty folder markers: no dialog needed.
    if (plan.documentIds.length === 0) {
      runBulkDelete(plan);
      return;
    }
    setBulkDeletePlan(plan);
  };

  const describeDeletePlan = (plan) => {
    const parts = [];
    if (plan.looseCount > 0) {
      parts.push(`${plan.looseCount} file${plan.looseCount === 1 ? '' : 's'}`);
    }
    if (plan.folderPaths.length > 0) {
      const folders = `${plan.folderPaths.length} folder${plan.folderPaths.length === 1 ? '' : 's'}`;
      parts.push(
        plan.nestedCount > 0
          ? `${folders} containing ${plan.nestedCount} document${plan.nestedCount === 1 ? '' : 's'}`
          : `${folders} (empty)`
      );
    }
    return `Delete ${parts.join(' and ')}? This can't be undone.`;
  };

  const runBulkDelete = async (plan) => {
    setBulkDeletePlan(null);
    setActionError('');
    setBulkDeleting(true);
    const ids = plan.documentIds;
    // allSettled rather than all: one failing delete shouldn't leave the
    // others un-applied just because Promise.all rejected on the first
    // failure - whichever succeeded should still disappear from the list.
    const results = await Promise.allSettled(ids.map((id) => deleteDocument(id)));
    const deletedIds = new Set(ids.filter((_, index) => results[index].status === 'fulfilled'));
    const failedCount = ids.length - deletedIds.size;

    // A folder is only removed if everything under it actually got deleted;
    // otherwise its marker stays so the leftovers remain reachable.
    const remainingPaths = documents
      .filter((doc) => !deletedIds.has(doc.id))
      .map((doc) => normalizeFolderPath(doc.folder));
    for (const folderPath of plan.folderPaths) {
      const hasLeftovers = remainingPaths.some(
        (path) => path === folderPath || path.startsWith(`${folderPath}/`)
      );
      if (!hasLeftovers) {
        // eslint-disable-next-line no-await-in-loop
        await deleteFolder(folderPath).catch(() => {});
      }
    }

    if (deletedIds.size > 0) {
      setDocuments((prev) => prev.filter((doc) => !deletedIds.has(doc.id)));
    }
    refreshFolders();
    if (failedCount > 0) {
      setActionError(
        `Could not delete ${failedCount} of ${ids.length} document${ids.length === 1 ? '' : 's'}.`
      );
    }

    setBulkDeleting(false);
    exitSelectMode();
  };

  const handleBulkShare = () => {
    const plan = resolveSelection();
    if (plan.documentIds.length === 0) return;
    // A lone loose document (no folder involved) opens the same single-file
    // share it always did; anything else is one link over the whole set.
    if (plan.documentIds.length === 1 && selectedFolders.size === 0) {
      const doc = documents.find((item) => item.id === plan.documentIds[0]);
      if (doc) setSharingSelection({ documentIds: [doc.id], title: `Share "${doc.filename}"` });
      return;
    }
    setSharingSelection({
      documentIds: plan.documentIds,
      title: `Share ${plan.documentIds.length} files`,
    });
  };

  const handleEditSaved = (updatedDocument) => {
    // Splice the updated metadata straight into the already-loaded list
    // and re-sort - PATCH's response has the same shape listDocuments
    // returns, so there's no need to refetch the whole list just because
    // one document's filename/folder/expiry changed.
    setDocuments((prev) =>
      sortByExpiryUrgency(
        prev.map((doc) => (doc.id === updatedDocument.id ? updatedDocument : doc))
      )
    );
    refreshFolders();
  };

  const closeAllPanels = () => {
    setUploadOpen(false);
    setBackupOpen(false);
    setRestoreOpen(false);
    setPairOpen(false);
    setDevicesOpen(false);
  };

  const openUploadPanel = () => {
    closeAllPanels();
    setUploadOpen(true);
  };

  const openBackupPanel = () => {
    closeAllPanels();
    setBackupOpen(true);
  };

  const openRestorePanel = () => {
    closeAllPanels();
    setRestoreOpen(true);
  };

  const openPairPanel = () => {
    closeAllPanels();
    setPairOpen(true);
  };

  const openDevicesPanel = () => {
    closeAllPanels();
    setDevicesOpen(true);
  };

  const closeBackupPanel = () => {
    setBackupOpen(false);
    setBackupError('');
    setBackupResult(null);
  };

  const closeRestorePanel = () => {
    setRestoreOpen(false);
    setRestoreError('');
    setRestoreResult(null);
  };

  const handleBackupExport = async (targetPath, usbPassphrase) => {
    setBackupSubmitting(true);
    setBackupError('');
    try {
      const result = await exportBackup(targetPath, usbPassphrase);
      setBackupResult(result);
      setBackupStatus({
        lastBackupAt: result.timestamp,
        documentCount: result.documentsBackedUp,
        backupPath: result.backupPath,
      });
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
      const result = await importBackup(sourcePath);
      setRestoreResult(result);
      await refresh();
    } catch (err) {
      setRestoreError(extractErrorMessage(err, 'Restore failed.'));
    } finally {
      setRestoreSubmitting(false);
    }
  };

  const normalizedSearch = searchTerm.trim().toLowerCase();
  const isSearching = normalizedSearch.length > 0;

  // Filtering is purely client-side against the already-fetched list - no
  // per-folder or per-search backend endpoint. Search deliberately
  // overrides folder scoping rather than combining with it (AND) - typing
  // in the search box searches every document regardless of currentPath,
  // matching how Drive's own search results view works.
  const visibleDocuments = useMemo(() => {
    if (isSearching) {
      return documents.filter((doc) => doc.filename.toLowerCase().includes(normalizedSearch));
    }
    return documents.filter((doc) => normalizeFolderPath(doc.folder) === currentPath);
  }, [documents, currentPath, isSearching, normalizedSearch]);

  // Immediate subfolders of currentPath, derived purely by splitting every
  // known folder path string (both documents' folders and empty Folder
  // records) - see utils/folderPath.js. Hidden entirely while searching,
  // matching Drive's flat search-results view.
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

  // Item count shown on each folder tile - every document nested anywhere
  // underneath that folder, including in its own subfolders.
  const subfolderItemCounts = useMemo(() => {
    const counts = new Map();
    for (const name of subfolderNames) {
      const subfolderPath = joinPath([...splitPath(currentPath), name]);
      const prefix = `${subfolderPath}/`;
      const count = documents.filter((doc) => {
        const path = normalizeFolderPath(doc.folder);
        return path === subfolderPath || path.startsWith(prefix);
      }).length;
      counts.set(name, count);
    }
    return counts;
  }, [documents, subfolderNames, currentPath]);

  // True only when there's genuinely nothing anywhere in the vault, not
  // just nothing at the current path - an empty subfolder still has a
  // breadcrumb to navigate back out with, so it gets its own "empty
  // folder" message further down instead of hiding the nav entirely.
  // GET /api/documents/folders always includes "root" even in a brand-new
  // vault (see documents.controller.js), so a plain folders.length check
  // would never see the vault as empty - normalize first and ignore that
  // implicit top-level entry.
  const vaultIsEmpty =
    documents.length === 0 && !folders.some((name) => normalizeFolderPath(name));

  const backupStatusLine = backupStatus?.lastBackupAt
    ? `Last backup: ${formatDateTime(backupStatus.lastBackupAt)} · ${backupStatus.documentCount} document${backupStatus.documentCount === 1 ? '' : 's'}`
    : backupStatus
      ? 'No backup yet'
      : '';

  return (
    <div className={styles.shell}>
      <Header
        onLock={onLocked}
        onToggleNav={() => setNavOpen((open) => !open)}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
      />

      <div className={styles.body}>
        <SideNav
          open={navOpen}
          onClose={() => setNavOpen(false)}
          onOpenDocuments={() => setCurrentPath('')}
          onOpenBackup={openBackupPanel}
          onOpenRestore={openRestorePanel}
          onOpenPair={openPairPanel}
          onOpenDevices={openDevicesPanel}
        />

        <main className={styles.content}>
          <div className={styles.contentInner}>
            <div className={styles.toolbar}>
              <div>
                <h1 className={styles.heading}>Your documents</h1>
                <p className={styles.count}>
                  {loading
                    ? 'Loading...'
                    : `${documents.length} document${documents.length === 1 ? '' : 's'}`}
                </p>
              </div>
              <div className={styles.toolbarActions}>
                {!selectMode && documents.length > 0 && (
                  <button type="button" className={styles.selectButton} onClick={enterSelectMode}>
                    <CheckSquare size={16} weight="bold" />
                    <span>Select</span>
                  </button>
                )}
                <NewMenu
                  onOpenNewFolder={() => setNewFolderOpen(true)}
                  onOpenUploadForm={openUploadPanel}
                  onFolderFilesSelected={handleUploadFolder}
                />
              </div>
            </div>

            {backupStatusLine && <p className={styles.backupStatusLine}>{backupStatusLine}</p>}

            {actionError && <p className={styles.banner}>{actionError}</p>}
            {listError && <p className={styles.banner}>{listError}</p>}

            {!loading && vaultIsEmpty && !listError && (
              <div className={styles.emptyState}>
                <FolderLock size={40} weight="light" className={styles.emptyIcon} />
                <h2 className={styles.emptyTitle}>Your vault is empty</h2>
                <p className={styles.emptyBody}>Add your first document to get started.</p>
              </div>
            )}

            {!vaultIsEmpty && (
              <div className={styles.listHeaderRow}>
                {isSearching ? (
                  <p className={styles.searchResultsLabel}>
                    Search results for &quot;{searchTerm.trim()}&quot;
                  </p>
                ) : (
                  <FolderBreadcrumb path={currentPath} onNavigate={setCurrentPath} />
                )}

                <div className={styles.viewToggle}>
                  <button
                    type="button"
                    className={`${styles.viewToggleButton} ${viewMode === 'list' ? styles.viewToggleActive : ''}`}
                    onClick={() => setViewMode('list')}
                    aria-label="List view"
                    aria-pressed={viewMode === 'list'}
                  >
                    <Rows size={16} weight="bold" />
                  </button>
                  <button
                    type="button"
                    className={`${styles.viewToggleButton} ${viewMode === 'grid' ? styles.viewToggleActive : ''}`}
                    onClick={() => setViewMode('grid')}
                    aria-label="Grid view"
                    aria-pressed={viewMode === 'grid'}
                  >
                    <SquaresFour size={16} weight="bold" />
                  </button>
                </div>
              </div>
            )}

            {!vaultIsEmpty && !isSearching && subfolderNames.length > 0 && (
              <ul className={styles.folderGrid}>
                {subfolderNames.map((name) => (
                  <FolderTile
                    key={name}
                    name={name}
                    itemCount={subfolderItemCounts.get(name) ?? 0}
                    onOpen={() => setCurrentPath(joinPath([...splitPath(currentPath), name]))}
                    selectMode={selectMode}
                    selected={selectedFolders.has(joinPath([...splitPath(currentPath), name]))}
                    onToggleSelect={() =>
                      toggleFolderSelected(joinPath([...splitPath(currentPath), name]))
                    }
                  />
                ))}
              </ul>
            )}

            {!vaultIsEmpty && subfolderNames.length === 0 && visibleDocuments.length === 0 && (
              <div className={styles.emptyState}>
                <FolderLock size={40} weight="light" className={styles.emptyIcon} />
                <h2 className={styles.emptyTitle}>No documents match</h2>
                <p className={styles.emptyBody}>
                  {isSearching
                    ? 'Try a different search.'
                    : 'This folder is empty. Add a document or create a subfolder here.'}
                </p>
              </div>
            )}

            {selectMode && (
              <div className={styles.bulkBar}>
                <span className={styles.bulkCount}>
                  {selectedIds.size + selectedFolders.size} selected
                </span>

                <div className={styles.bulkActions}>
                  <button
                    type="button"
                    className={styles.bulkDeleteButton}
                    onClick={handleBulkDeleteClick}
                    disabled={selectedIds.size + selectedFolders.size === 0 || bulkDeleting}
                  >
                    <Trash size={16} weight="bold" />
                    <span>{bulkDeleting ? 'Deleting...' : 'Delete'}</span>
                  </button>

                  <button
                    type="button"
                    className={styles.bulkShareButton}
                    onClick={handleBulkShare}
                    disabled={selectedIds.size + selectedFolders.size === 0 || bulkDeleting}
                  >
                    <ShareNetwork size={16} weight="bold" />
                    <span>Share</span>
                  </button>

                  <button type="button" className={styles.bulkDoneButton} onClick={exitSelectMode}>
                    Done
                  </button>
                </div>
              </div>
            )}

            {visibleDocuments.length > 0 && viewMode === 'list' && (
              <ul className={styles.list}>
                {visibleDocuments.map((doc) => (
                  <DocumentRow
                    key={doc.id}
                    document={doc}
                    onView={handleView}
                    onDelete={handleDelete}
                    onShare={(doc) => setSharingSelection({ documentIds: [doc.id], title: `Share "${doc.filename}"` })}
                    onEdit={setEditingDocument}
                    isViewing={viewingId === doc.id}
                    isDeleting={deletingId === doc.id}
                    selectMode={selectMode}
                    selected={selectedIds.has(doc.id)}
                    onToggleSelect={toggleSelected}
                  />
                ))}
              </ul>
            )}

            {visibleDocuments.length > 0 && viewMode === 'grid' && (
              <ul className={styles.grid}>
                {visibleDocuments.map((doc) => (
                  <DocumentCard
                    key={doc.id}
                    document={doc}
                    onView={handleView}
                    onDelete={handleDelete}
                    onShare={(doc) => setSharingSelection({ documentIds: [doc.id], title: `Share "${doc.filename}"` })}
                    onEdit={setEditingDocument}
                    isViewing={viewingId === doc.id}
                    isDeleting={deletingId === doc.id}
                    selectMode={selectMode}
                    selected={selectedIds.has(doc.id)}
                    onToggleSelect={toggleSelected}
                  />
                ))}
              </ul>
            )}
          </div>
        </main>
      </div>

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
            destinationLabel={currentPath || 'Documents'}
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
              <div
                className={styles.progressTrack}
                role="progressbar"
                aria-valuenow={uploadProgress}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div className={styles.progressFill} style={{ width: `${uploadProgress}%` }} />
              </div>
            </>
          ) : (
            <>
              {uploadError ? (
                <p className={styles.banner} role="alert">
                  {uploadError}
                </p>
              ) : (
                <p className={styles.folderUploadLabel}>
                  Uploaded {folderUploadCount} file{folderUploadCount === 1 ? '' : 's'} to{' '}
                  {currentPath || 'Documents'}.
                </p>
              )}
              <div className={styles.modalActions}>
                <button
                  type="button"
                  className={styles.bulkDoneButton}
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

      {backupOpen && (
        <Modal title="Backup to USB" onClose={closeBackupPanel}>
          <BackupPanel
            onSubmit={handleBackupExport}
            onCancel={closeBackupPanel}
            submitting={backupSubmitting}
            error={backupError}
            result={backupResult}
          />
        </Modal>
      )}

      {restoreOpen && (
        <Modal title="Restore from backup" onClose={closeRestorePanel}>
          <RestorePanel
            onSubmit={handleRestoreImport}
            onCancel={closeRestorePanel}
            submitting={restoreSubmitting}
            error={restoreError}
            result={restoreResult}
          />
        </Modal>
      )}

      {pairOpen && (
        <Modal title="Pair a device" onClose={() => setPairOpen(false)}>
          <PairDevicePanel onClose={() => setPairOpen(false)} />
        </Modal>
      )}

      {devicesOpen && (
        <Modal title="Paired devices" onClose={() => setDevicesOpen(false)}>
          <PairedDevicesPanel />
        </Modal>
      )}

      {newFolderOpen && (
        <NewFolderModal
          onClose={() => setNewFolderOpen(false)}
          onCreated={handleFolderCreated}
          currentPath={currentPath}
        />
      )}

      {sharingSelection && (
        <ShareModal
          key={sharingSelection.documentIds.join(',')}
          documentIds={sharingSelection.documentIds}
          title={sharingSelection.title}
          onClose={() => setSharingSelection(null)}
        />
      )}

      {bulkDeletePlan && (
        <Modal title="Delete selection?" onClose={() => setBulkDeletePlan(null)}>
          <p className={styles.confirmText}>{describeDeletePlan(bulkDeletePlan)}</p>
          <div className={styles.modalActions}>
            <button type="button" className={styles.confirmNo} onClick={() => setBulkDeletePlan(null)}>
              Cancel
            </button>
            <button
              type="button"
              className={styles.confirmYes}
              onClick={() => runBulkDelete(bulkDeletePlan)}
            >
              Delete
            </button>
          </div>
        </Modal>
      )}

      {editingDocument && (
        <EditDocumentModal
          document={editingDocument}
          onClose={() => setEditingDocument(null)}
          onSaved={handleEditSaved}
        />
      )}
    </div>
  );
}

export default VaultShell;
