import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowsOutCardinal,
  Camera,
  CalendarBlank,
  DownloadSimple,
  Eye,
  FolderLock,
  FolderOpen,
  FolderSimplePlus,
  Info,
  PencilSimple,
  Rows,
  ShareNetwork,
  SquaresFour,
  Star,
  Trash,
  UploadSimple,
} from '@phosphor-icons/react';

import FileBrowser, { SelectAllCheckbox, focusBrowserItem } from '../components/FileBrowser.jsx';
import ContextMenu from '../components/ContextMenu.jsx';
import { useDetailsPanel } from '../components/useDetailsPanel.jsx';
import { ListSkeleton } from '../components/Skeletons.jsx';
import { JUST_ASKED_MS } from '../services/dataCache.js';
import FilePreview from '../components/FilePreview.jsx';
import SelectionBar from '../components/SelectionBar.jsx';
import { useShell } from '../components/ShellContext.js';
import UploadForm from '../components/UploadForm.jsx';
import NewMenu from '../components/NewMenu.jsx';
import NewFolderModal from '../components/NewFolderModal.jsx';
import PreviewsNotice from '../components/PreviewsNotice.jsx';
import FrequentFiles from '../components/FrequentFiles.jsx';
import ExpiringBanner from '../components/ExpiringBanner.jsx';
import ExpiryModal from '../components/ExpiryModal.jsx';
import { expiryBadge } from '../utils/expiry.js';
import Modal from '../components/Modal.jsx';
import ShareModal from '../components/ShareModal.jsx';
import EditDocumentModal from '../components/EditDocumentModal.jsx';
import FolderBreadcrumb from '../components/FolderBreadcrumb.jsx';
import MoveModal from '../components/MoveModal.jsx';
import RenameFolderModal from '../components/RenameFolderModal.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import dropdownStyles from '../components/DropdownMenu.module.css';
import {
  listDocuments,
  peekDocuments,
  peekFolders,
  uploadDocument,
  renamedNotice,
  THUMBNAIL_READY,
  putThumbnail,
  deleteDocument,
  deleteFolder,
  downloadBytes,
  fetchDocumentBytes,
  getStorage,
  listFolders,
  starDocuments,
  uploadNewVersion,
  MAX_UPLOAD_BYTES,
  TOO_LARGE_MESSAGE,
  batchMoveDocuments,
  batchTrashDocuments,
} from '../services/documentsService.js';
import { DOCUMENTS_CHANGED, describeMove } from '../utils/dragMove.js';
import { splitIntoBlocks } from '../utils/fileBlocks.js';
import { usePreviewGenerator } from '../utils/usePreviewGenerator.js';
import { extractErrorMessage } from '../services/api.js';
import { invalidateThumbnail } from '../services/thumbnailCache.js';
import { generateThumbnail } from '../utils/thumbnail.js';
import { formatDate } from '../utils/formatDate.js';
import { SORT_OPTIONS, formatBytes, sortItems } from '../utils/listing.js';
import { uploadFitsMessage } from '../utils/storageUsage.js';
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

// The scanner (camera input, crop, Document mode, PDF writer) is loaded the first time Scan is pressed.
const ScanDialog = lazy(() => import('../components/scan/ScanDialog.jsx'));

// A 401 mid-request means the session just expired - the axios interceptor
// already clears it, and the route guard is about to unmount this page.
const isSessionExpired = (err) => err?.response?.status === 401;


// Name takes the rest; these are fixed but proportional to the screen, so wide
// screens spread the content instead of leaving an empty band on the right.
const FILE_COLUMNS = [
  { id: 'modified', label: 'Modified', width: 'clamp(110px, 14vw, 380px)' },
  { id: 'size', label: 'Size', width: 'clamp(84px, 9vw, 240px)', align: 'right' },
  { id: 'shared', label: 'Shared', width: 'clamp(72px, 8vw, 220px)' },
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

  // Coming back to this page starts from the last answer (services/dataCache.js) and refreshes it in the background.
  const [documents, setDocuments] = useState(() => peekDocuments() ?? []);
  const [loading, setLoading] = useState(() => peekDocuments() === undefined);
  const [listError, setListError] = useState('');
  const [folders, setFolders] = useState(() => peekFolders() ?? []);

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
  const [expiryDocument, setExpiryDocument] = useState(null);
  const [moveState, setMoveState] = useState(null);
  const [renamingPath, setRenamingPath] = useState(null);
  const [sharingSelection, setSharingSelection] = useState(null);
  const [previewIndex, setPreviewIndex] = useState(null);
  const [contextMenu, setContextMenu] = useState(null); // { x, y, items, label, opener }
  const folderInputRef = useRef(null);
  const [scanOpen, setScanOpen] = useState(false);
  const versionInputRef = useRef(null);
  const versionTarget = useRef(null);

  const refresh = useCallback(async ({ quiet = false, reuse = false } = {}) => {
    if (!quiet) setLoading(true);
    setListError('');
    try {
      setDocuments(await listDocuments(reuse ? { maxAgeMs: JUST_ASKED_MS } : undefined));
    } catch (err) {
      if (!isSessionExpired(err)) setListError(extractErrorMessage(err, 'Could not load your documents.'));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshFolders = useCallback(async ({ sidebar = true, reuse = false } = {}) => {
    try {
      setFolders(await listFolders(reuse ? { maxAgeMs: JUST_ASKED_MS } : undefined));
    } catch {
      // The folder list is a convenience; a failed fetch leaves the tree as it was.
    }
    if (sidebar) refreshSidebar();
  }, [refreshSidebar]);

  // On arriving: both lists ask at once. With a remembered answer the page is already showing it, so the refresh is
  // quiet, and the sidebar (which loaded its own tree) is not asked to reload for nothing.
  useEffect(() => {
    refresh({ quiet: peekDocuments() !== undefined, reuse: true });
    refreshFolders({ sidebar: false, reuse: true });
  }, [refresh, refreshFolders]);

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
        // Red once expired, amber within 60 days; nothing otherwise.
        badge: (() => {
          const chip = expiryBadge(doc);
          return chip ? <StatusBadge label={chip.label} tone={chip.tone} /> : null;
        })(),
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
  const blocks = useMemo(() => splitIntoBlocks(items), [items]);
  const fileItems = blocks.files;
  const folderItems = blocks.folders;
  // Select-all means the files; a folder is selected on its own tile.
  const selection = useSelection(orderedKeys, blocks.selectAllKeys);
  const previewFiles = useMemo(() => fileItems.map((item) => item.document), [fileItems]);

  const vaultIsEmpty = documents.length === 0 && !folders.some((name) => normalizeFolderPath(name));

  // ---- uploads ----
  const uploadAbort = useRef(null);
  const handleUpload = async ({ file, expiryDate }) => {
    // The form has locked itself already (one request per press). This lock is the second line: one upload at a time.
    if (uploadAbort.current) return;
    const controller = new AbortController();
    uploadAbort.current = controller;
    setUploading(true);
    setUploadProgress(0);
    setUploadError('');
    try {
      // Refused before anything is sent when it cannot fit (the server checks again regardless).
      const tooBig = uploadFitsMessage(await getStorage().catch(() => null), file.size);
      if (tooBig) {
        setUploadError(tooBig);
        return;
      }
      const saved = await uploadDocument({ file, folder: currentPath || undefined, expiryDate, signal: controller.signal }, setUploadProgress);
      setUploadOpen(false);
      const notice = renamedNotice(saved);
      if (notice) showToast(notice);
      await refresh();
      refreshFolders();
    } catch (err) {
      if (controller.signal.aborted) {
        // Say what happened: the request was stopped here, but a request that had already been fully sent may have been stored.
        setUploadError('Upload cancelled. If the file had already reached the server it may still appear in your list.');
        refresh({ quiet: true });
      } else {
        setUploadError(extractErrorMessage(err, 'Upload failed.'));
      }
    } finally {
      uploadAbort.current = null;
      setUploading(false);
    }
  };

  const handleUploadFolder = async (fileList) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    setUploadOpen(false);
    setFolderUploadOpen(true);
    const tooBig = uploadFitsMessage(await getStorage().catch(() => null), files.reduce((sum, file) => sum + file.size, 0));
    if (tooBig) {
      setUploadError(tooBig);
      return;
    }
    setFolderUploadCount(0);
    setUploading(true);
    setUploadProgress(0);
    setUploadError('');
    try {
      let renamed = 0;
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const relativeDir = relativeDirFromPath(file.webkitRelativePath || file.name);
        const folder = combineFolderPath(currentPath, relativeDir);
        // eslint-disable-next-line no-await-in-loop
        const saved = await uploadDocument({ file, folder }, (filePercent) => {
          setUploadProgress(Math.round(((index + filePercent / 100) / files.length) * 100));
        });
        if (saved?.nameChanged) renamed += 1;
      }
      if (renamed > 0) showToast(`${renamed} file${renamed === 1 ? ' was' : 's were'} saved with a number added to its name, because a file with that name already existed.`);
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
    setDocuments((prev) => prev.map((doc) => (doc.id === id ? { ...doc, hasThumb: true, thumbFailed: false, thumbFailReason: null } : doc)));
  }, []);

  // A preview drawn just after an upload (the upload no longer waits for it) shows as soon as it is stored.
  useEffect(() => {
    const onReady = (event) => event.detail?.id && markThumbnailAdded(event.detail.id);
    window.addEventListener(THUMBNAIL_READY, onReady);
    return () => window.removeEventListener(THUMBNAIL_READY, onReady);
  }, [markThumbnailAdded]);

  // Background previews (opt-in): a made preview shows at once, a failed one is remembered so it is not retried.
  const previews = usePreviewGenerator({
    documents,
    onResult: (result) => {
      if (result.status === 'done') {
        markThumbnailAdded(result.id);
      } else {
        setDocuments((prev) =>
          prev.map((doc) =>
            doc.id === result.id
              ? { ...doc, thumbFailed: true, thumbFailReason: result.reason, previewKind: result.reason === 'unsupported-type' ? 'none' : doc.previewKind }
              : doc
          )
        );
      }
    },
  });

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

  // "Open" links from the Overview and the Frequently used row: show that file's preview once the list is in.
  const openId = params.get('open');
  useEffect(() => {
    if (!openId || loading) return;
    const index = previewFiles.findIndex((doc) => String(doc.id) === openId);
    if (index !== -1) setPreviewIndex(index);
    const next = new URLSearchParams(params);
    next.delete('open');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, loading, previewFiles]);

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
        // The server names the download (extension recovered from the bytes when the name has none).
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

  // ---- stars and the details panel ----
  // The star shows at once and is put back if the server refuses; the cached lists are emptied by the write itself.
  const setStar = async (ids, value) => {
    setActionError('');
    const mark = (to) => setDocuments((prev) => prev.map((doc) => (ids.includes(doc.id) ? { ...doc, starred: to } : doc)));
    mark(value);
    try {
      await starDocuments(ids, value);
    } catch (err) {
      mark(!value);
      if (!isSessionExpired(err)) setActionError(extractErrorMessage(err, 'Could not change the star.'));
    }
  };
  const toggleStarItem = (item) => setStar([item.id], !item.document.starred);
  const details = useDetailsPanel({
    isStarred: (id) => Boolean(documents.find((doc) => doc.id === id)?.starred),
    toggleStar: (id) => setStar([id], !documents.find((doc) => doc.id === id)?.starred),
    onChanged: ({ id, kind, hasNote }) => {
      if (kind === 'note') setDocuments((prev) => prev.map((doc) => (doc.id === id ? { ...doc, hasNote } : doc)));
      // New contents: the size, the preview and the modified time are different, so the list is read again.
      if (kind === 'file') {
        invalidateThumbnail(id);
        refresh();
      }
    },
  });

  // "Upload new version" from the file's menu: the same call as the button in the details panel.
  const handleVersionPicked = async (event) => {
    const file = event.target.files?.[0];
    const doc = versionTarget.current;
    event.target.value = '';
    if (!file || !doc) return;
    setActionError('');
    if (file.size > MAX_UPLOAD_BYTES) {
      setActionError(TOO_LARGE_MESSAGE);
      return;
    }
    try {
      await uploadNewVersion(doc.id, file);
      invalidateThumbnail(doc.id);
      showToast(`Uploaded a new version of "${doc.filename}"`);
      await refresh();
    } catch (err) {
      if (!isSessionExpired(err)) setActionError(extractErrorMessage(err, 'Could not upload the new version.'));
    }
  };

  const handleBulkTrash = async () => {
    setActionError('');
    setBusy(true);
    const plan = resolveSelection();
    // One request per 50 files (the server's limit), a result for each; a failure must not undo the rest.
    let fileTrashed = 0;
    let fileFailed = 0;
    if (plan.looseIds.length > 0) {
      try {
        const response = await batchTrashDocuments(plan.looseIds);
        fileTrashed = response.trashedCount;
        fileFailed = plan.looseIds.length - response.trashedCount;
      } catch {
        fileFailed = plan.looseIds.length;
      }
    }
    const folderResults = await Promise.allSettled(selectedFolderPaths.map((path) => deleteFolder(path)));
    const folderFailed = folderResults.filter((result) => result.status === 'rejected').length;
    const failed = fileFailed + folderFailed;
    const moved = fileTrashed + selectedFolderPaths.length - folderFailed;
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

  // Files dropped on a folder (one, or the whole selection): the batch move, which answers for each file.
  const handleDropDocument = async (ids, folderItem) => {
    setActionError('');
    try {
      const response = await batchMoveDocuments(ids, folderItem.path);
      const outcome = describeMove(response);
      if (response.movedCount > 0) {
        showToast(outcome.message);
        selection.clear();
        await refresh();
        refreshFolders();
      } else if (outcome.error) {
        setActionError(outcome.error);
      }
    } catch (err) {
      if (!isSessionExpired(err)) setActionError(extractErrorMessage(err, 'Could not move these files.'));
    }
  };

  // Files moved by a drop on the sidebar's folder tree (outside this page) announce themselves; show it and reload.
  useEffect(() => {
    const onChanged = async (event) => {
      if (event.detail?.message) showToast(event.detail.message);
      if (event.detail?.error) setActionError(event.detail.error);
      await refresh();
      refreshFolders();
    };
    window.addEventListener(DOCUMENTS_CHANGED, onChanged);
    return () => window.removeEventListener(DOCUMENTS_CHANGED, onChanged);
  }, [refresh, refreshFolders, showToast]);

  // A new "Expires on" date: only its fields change in the list; the banner and Overview read it from the server.
  const handleExpirySaved = (updated) => {
    setDocuments((prev) =>
      prev.map((doc) =>
        doc.id === updated.id
          ? { ...doc, expiryDate: updated.expiryDate, docExpiresAt: updated.docExpiresAt, daysUntilExpiry: updated.daysUntilExpiry, expiryStatus: updated.expiryStatus }
          : doc
      )
    );
    showToast(updated.docExpiresAt ? 'Expiry date saved' : 'Expiry date removed');
  };

  const handleEditSaved = (updated) => {
    setDocuments((prev) => prev.map((doc) => (doc.id === updated.id ? { ...doc, ...updated } : doc)));
    refreshFolders();
  };

  // Old links to the pair / paired-devices panels now land on the Devices page.
  useEffect(() => {
    if (['pair', 'devices'].includes(params.get('panel'))) navigate('/devices', { replace: true });
  }, [params, navigate]);
  // ---- menus: one set of actions for the "..." button, right-click, long-press and Shift+F10 ----
  const icon = (Icon) => <Icon size={18} weight="light" className={dropdownStyles.optionIcon} />;

  const shareFolder = (item) => {
    const prefix = `${item.path}/`;
    const ids = documents
      .filter((doc) => {
        const path = normalizeFolderPath(doc.folder);
        return path === item.path || path.startsWith(prefix);
      })
      .map((doc) => doc.id);
    if (ids.length === 0) {
      setActionError('This folder has no files to share yet.');
      return;
    }
    setSharingSelection({ documentIds: ids, title: `Share folder "${item.name}"` });
  };

  const menuFor = (item) => {
    if (item.kind === 'folder') {
      return [
        { label: 'Open', icon: icon(FolderOpen), onSelect: () => openItem(item) },
        { label: 'Share', icon: icon(ShareNetwork), onSelect: () => shareFolder(item) },
        { label: 'Rename', icon: icon(PencilSimple), onSelect: () => setRenamingPath(item.path) },
        { label: 'Move to…', icon: icon(ArrowsOutCardinal), onSelect: () => openMoveForFolder(item.path) },
        { label: 'Move to trash', danger: true, icon: icon(Trash), onSelect: () => handleTrashFolderFromMenu(item) },
      ];
    }
    const doc = item.document;
    return [
      { label: 'Open / Preview', icon: icon(Eye), onSelect: () => openItem(item) },
      { label: 'Details', icon: icon(Info), onSelect: () => details.show(doc.id, doc.filename, null) },
      { label: doc.starred ? 'Remove star' : 'Star', icon: icon(Star), onSelect: () => setStar([doc.id], !doc.starred) },
      { label: 'Download', icon: icon(DownloadSimple), onSelect: () => handleDownloadFiles([doc]) },
      { label: 'Upload new version…', icon: icon(UploadSimple), onSelect: () => { versionTarget.current = doc; versionInputRef.current?.click(); } },
      { label: 'Share', icon: icon(ShareNetwork), onSelect: () => setSharingSelection({ documentIds: [doc.id], title: `Share "${doc.filename}"` }) },
      { label: 'Rename', icon: icon(PencilSimple), onSelect: () => setEditingDocument(doc) },
      { label: doc.docExpiresAt ? 'Change expiry date…' : 'Set expiry date…', icon: icon(CalendarBlank), onSelect: () => setExpiryDocument(doc) },
      { label: 'Move to…', icon: icon(ArrowsOutCardinal), onSelect: () => openMoveForDocument(doc) },
      { label: 'Move to trash', danger: true, icon: icon(Trash), onSelect: () => handleTrashFromMenu(doc) },
    ];
  };

  const allStarred = selectedFiles.length > 0 && selectedFiles.every((doc) => doc.starred);
  const selectionActions = [
    {
      key: 'download',
      label: 'Download',
      icon: <DownloadSimple size={18} />,
      onClick: () => handleDownloadFiles(selectedFiles),
      disabled: busy || selectedFiles.length === 0 || selectedFolderPaths.length > 0,
      title: selectedFolderPaths.length > 0 ? 'Folders cannot be downloaded: select only files' : undefined,
    },
    { key: 'share', label: 'Share', icon: <ShareNetwork size={18} />, onClick: handleBulkShare, disabled: busy },
    {
      key: 'star',
      label: allStarred ? 'Remove star' : 'Star',
      icon: <Star size={18} weight={allStarred ? 'fill' : 'regular'} />,
      onClick: () => setStar(selectedFiles.map((doc) => doc.id), !allStarred),
      disabled: busy || selectedFiles.length === 0,
      title: selectedFiles.length === 0 ? 'Select files to star them' : undefined,
    },
    { key: 'move', label: 'Move to…', icon: <ArrowsOutCardinal size={18} />, onClick: openMoveForSelection, disabled: busy },
    { key: 'trash', label: 'Move to trash', icon: <Trash size={18} />, onClick: handleBulkTrash, disabled: busy, danger: true },
  ];

  const ACTION_ICONS = { download: DownloadSimple, share: ShareNetwork, star: Star, move: ArrowsOutCardinal, trash: Trash };
  const selectionMenuItems = () =>
    selectionActions.map((action) => ({
      label: action.label,
      icon: icon(ACTION_ICONS[action.key]),
      onSelect: action.onClick,
      disabled: action.disabled,
      title: action.title,
      danger: action.danger,
    }));

  const backgroundMenuItems = () => [
    { label: 'New folder', icon: icon(FolderSimplePlus), onSelect: () => setNewFolderOpen(true) },
    { label: 'Upload file', icon: icon(UploadSimple), onSelect: () => setUploadOpen(true) },
    { label: 'Upload folder', icon: icon(UploadSimple), onSelect: () => folderInputRef.current?.click() },
  ];

  // Right-click on an item: an unselected item becomes the selection first;
  // several selected items get the actions that apply to a selection.
  const handleItemContextMenu = (item, { x, y, opener }) => {
    const wasSelected = selection.isSelected(item.key);
    if (!wasSelected) selection.setOnly(item.key);
    const multiple = wasSelected && selection.count > 1;
    setContextMenu({
      x,
      y,
      opener,
      label: multiple ? `${selection.count} selected items` : item.name,
      items: multiple ? selectionMenuItems() : menuFor(item),
    });
  };

  // Right-click on empty space inside the files area (the browser menu is
  // suppressed only here, not on the rest of the page).
  const handleAreaContextMenu = (event) => {
    if (event.target.closest('[data-file-key], a, input, select, button, textarea')) return;
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, opener: null, label: 'New', items: backgroundMenuItems() });
  };

  const emptyHere = !loading && !vaultIsEmpty && items.length === 0;

  return (
    <div className={styles.page} onContextMenu={handleAreaContextMenu}>
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
            <button type="button" className={styles.scanButton} onClick={() => setScanOpen(true)}>
              <Camera size={16} weight="bold" />
              <span>Scan</span>
            </button>
            <NewMenu
              onOpenNewFolder={() => setNewFolderOpen(true)}
              onOpenUploadForm={() => setUploadOpen(true)}
              onFolderFilesSelected={handleUploadFolder}
            />
          </div>
        </div>
      )}

      {selection.count === 0 && <PreviewsNotice generator={previews} documents={documents} onRetried={refresh} />}
      {!searchTerm && <ExpiringBanner />}
      {selection.count === 0 && !currentPath && !searchTerm && <FrequentFiles />}
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

      <div className={styles.area}>
      {loading && items.length === 0 && !listError && <ListSkeleton />}
      {folderItems.length > 0 && (
        <section className={styles.block} aria-labelledby="folders-heading">
          <h2 id="folders-heading" className={styles.blockHead}>
            Folders <span className={styles.blockCount}>{folderItems.length}</span>
          </h2>
          <FileBrowser
            items={folderItems}
            view="tiles"
            selection={selection}
            onOpen={openItem}
            menuFor={menuFor}
            onItemContextMenu={handleItemContextMenu}
            onDropOnFolder={handleDropDocument}
            label="Folders"
          />
        </section>
      )}
      {folderItems.length > 0 && <hr className={styles.blockDivider} />}
      {items.length > 0 && (
        <section className={styles.block} aria-labelledby="files-heading">
          <h2 id="files-heading" className={styles.blockHead}>
            Files <span className={styles.blockCount}>{fileItems.length}</span>
          </h2>
          {fileItems.length > 0 ? (
            <FileBrowser
              items={fileItems}
              view={view}
              selection={selection}
              onOpen={openItem}
              columns={FILE_COLUMNS}
              menuFor={menuFor}
              onItemContextMenu={handleItemContextMenu}
              onDropOnFolder={handleDropDocument}
              onToggleStar={toggleStarItem}
              onShowDetails={(item, opener) => details.show(item.id, item.name, opener)}
              label="Files"
            />
          ) : (
            <p className={styles.blockEmpty}>
              No files in this folder yet.{' '}
              <button type="button" className={styles.linkButton} onClick={() => setUploadOpen(true)}>
                Upload here
              </button>
            </p>
          )}
        </section>
      )}
      </div>

      <input
        ref={folderInputRef}
        type="file"
        hidden
        // Whole-folder picking: non-standard attributes React passes straight through.
        webkitdirectory=""
        multiple
        onChange={(event) => {
          if (event.target.files?.length) handleUploadFolder(event.target.files);
          event.target.value = '';
        }}
      />

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

      {previewIndex !== null && previewFiles.length > 0 && (
        <FilePreview
          files={previewFiles}
          index={Math.min(previewIndex, previewFiles.length - 1)}
          onIndexChange={setPreviewIndex}
          onClose={closePreview}
          onShare={(doc) => setSharingSelection({ documentIds: [doc.id], title: `Share "${doc.filename}"` })}
          onRename={setEditingDocument}
          onSetExpiry={setExpiryDocument}
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
            onAbort={() => uploadAbort.current?.abort()}
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

      {expiryDocument && (
        <ExpiryModal document={expiryDocument} onClose={() => setExpiryDocument(null)} onSaved={handleExpirySaved} />
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
      {scanOpen && (
        <Suspense fallback={null}>
          <ScanDialog
            folderPaths={[...folders, ...documents.map((doc) => normalizeFolderPath(doc.folder))]}
            currentPath={currentPath}
            onClose={() => setScanOpen(false)}
            // The upload has already emptied the page cache (every write does) and the server has logged it; read the list again.
            onSaved={async (saved, notices = []) => {
              if (notices.length > 0) showToast(notices[0]);
              await refresh();
              refreshFolders();
            }}
          />
        </Suspense>
      )}

      {details.element}
      <input ref={versionInputRef} type="file" hidden tabIndex={-1} aria-hidden="true" onChange={handleVersionPicked} />
    </div>
  );
}

export default FilesPage;
