import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Eye, DownloadSimple, FolderLock, Rows, SquaresFour } from '@phosphor-icons/react';

import FileBrowser from '../components/FileBrowser.jsx';
import FilePreview from '../components/FilePreview.jsx';
import FolderBreadcrumb from '../components/FolderBreadcrumb.jsx';
import dropdownStyles from '../components/DropdownMenu.module.css';
import { downloadBytes, fetchDocumentBytes, listDocuments, listFolders } from '../services/documentsService.js';
import { UNAVAILABLE_MESSAGE, isUnavailable } from '../utils/emergencyMode.js';
import { formatDate } from '../utils/formatDate.js';
import { getImmediateChildren, joinPath, normalizeFolderPath, splitPath } from '../utils/folderPath.js';
import { SORT_OPTIONS, formatBytes, sortItems } from '../utils/listing.js';
import { getViewPrefs, setViewPref } from '../utils/viewPrefs.js';
import { usePageMeta } from '../utils/usePageMeta.js';
import styles from './FilePages.module.css';

// A selection that never selects: the shared browser needs one, a read-only one has none.
const NO_SELECTION = Object.freeze({
  count: 0,
  header: 'none',
  isSelected: () => false,
  click: () => {},
  clear: () => {},
  selectAll: () => {},
});

const COLUMNS = [
  { id: 'modified', label: 'Modified', width: 'clamp(110px, 14vw, 380px)' },
  { id: 'size', label: 'Size', width: 'clamp(84px, 9vw, 240px)', align: 'right' },
];

/**
 * The contact's Files: the same list and preview as the owner's, with everything that changes anything taken away.
 * Open / Preview and Download are all there is. The paths shown start at the folder the owner chose (the server
 * never sends the names above it). A 403 or 404 is an ordinary "This item isn't available." with a way back, never
 * a broken page.
 */
function EmergencyFilesPage() {
  usePageMeta('Files', 'Read-only emergency access.');
  const [params, setParams] = useSearchParams();
  const currentPath = normalizeFolderPath(params.get('path') || '');
  const [documents, setDocuments] = useState([]);
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [listError, setListError] = useState('');
  const [view, setView] = useState(() => getViewPrefs().view);
  const [sort, setSort] = useState(() => getViewPrefs().sort);
  const [query, setQuery] = useState('');
  const [previewIndex, setPreviewIndex] = useState(null);
  const [actionError, setActionError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setListError('');
    try {
      const [docs, folderList] = await Promise.all([listDocuments(), listFolders().catch(() => [])]);
      setDocuments(docs);
      setFolders(folderList);
    } catch (err) {
      if (isUnavailable(err)) setUnavailable(true);
      else if (err?.response?.status !== 401) setListError('We couldn’t load the files. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setCurrentPath = (path) => {
    setParams(path ? { path } : {}, { replace: false });
    setPreviewIndex(null);
    setUnavailable(false);
  };

  const needle = query.trim().toLowerCase();
  const searching = needle.length > 0;

  const visibleDocuments = useMemo(() => {
    if (searching) return documents.filter((doc) => doc.filename.toLowerCase().includes(needle));
    return documents.filter((doc) => normalizeFolderPath(doc.folder) === currentPath);
  }, [documents, currentPath, searching, needle]);

  const subfolderNames = useMemo(() => {
    if (searching) return [];
    const all = new Set();
    for (const doc of documents) {
      const path = normalizeFolderPath(doc.folder);
      if (path) all.add(path);
    }
    for (const name of folders) {
      const path = normalizeFolderPath(name);
      if (path) all.add(path);
    }
    return getImmediateChildren(all, currentPath);
  }, [documents, folders, currentPath, searching]);

  const items = useMemo(() => {
    const folderItems = subfolderNames.map((name) => {
      const path = joinPath([...splitPath(currentPath), name]);
      const count = documents.filter((doc) => normalizeFolderPath(doc.folder) === path || normalizeFolderPath(doc.folder).startsWith(`${path}/`)).length;
      return { key: `folder:${path}`, kind: 'folder', path, name, subtitle: `${count} item${count === 1 ? '' : 's'}`, cells: { modified: '—', size: `${count} item${count === 1 ? '' : 's'}` } };
    });
    const fileItems = visibleDocuments.map((doc) => {
      const modified = doc.updatedAt || doc.createdAt;
      return {
        key: `file:${doc.id}`,
        kind: 'file',
        id: doc.id,
        name: doc.filename,
        size: doc.size ?? 0,
        modified,
        document: doc,
        thumbDocument: doc,
        subtitle: `${formatDate(modified)} · ${formatBytes(doc.size)}`,
        cells: { modified: formatDate(modified), size: formatBytes(doc.size) },
      };
    });
    return sortItems([...folderItems, ...fileItems], sort);
  }, [subfolderNames, visibleDocuments, documents, currentPath, sort]);

  const files = useMemo(() => items.filter((item) => item.kind === 'file').map((item) => item.document), [items]);

  const openItem = (item) => {
    if (item.kind === 'folder') {
      setCurrentPath(item.path);
      return;
    }
    const index = files.findIndex((doc) => doc.id === item.id);
    if (index >= 0) setPreviewIndex(index);
  };

  const download = async (doc) => {
    setActionError('');
    try {
      const { bytes, filename } = await fetchDocumentBytes(doc.id, { purpose: 'download' });
      downloadBytes(bytes, filename ?? doc.filename);
    } catch (err) {
      setActionError(isUnavailable(err) ? UNAVAILABLE_MESSAGE : 'Download failed. Please try again.');
    }
  };

  // Only these two, in the "..." menu.
  const icon = (Icon) => <Icon size={18} weight="light" className={dropdownStyles.optionIcon} />;
  const menuFor = (item) =>
    item.kind === 'folder'
      ? [{ label: 'Open', icon: icon(Eye), onSelect: () => openItem(item) }]
      : [
          { label: 'Open / Preview', icon: icon(Eye), onSelect: () => openItem(item) },
          { label: 'Download', icon: icon(DownloadSimple), onSelect: () => download(item.document) },
        ];

  if (unavailable) {
    return (
      <div className={styles.page}>
        <div className={styles.empty} role="alert" data-testid="unavailable">
          <FolderLock size={22} weight="light" className={styles.emptyIcon} />
          <span>{UNAVAILABLE_MESSAGE}</span>
          <button type="button" className={styles.secondaryButton} onClick={() => { setCurrentPath(''); load(); }}>
            Back to Files
          </button>
        </div>
      </div>
    );
  }

  const empty = !loading && !listError && items.length === 0;

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div className={styles.titleBlock}>
          <FolderBreadcrumb path={currentPath} onNavigate={setCurrentPath} rootLabel="Files" />
          <span className={styles.count}>{loading ? 'Loading…' : `${documents.length} document${documents.length === 1 ? '' : 's'}`}</span>
        </div>
        <div className={styles.controls}>
          <input
            type="search"
            className={styles.sort}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter these files"
            aria-label="Filter these files"
          />
          <select
            className={styles.sort}
            value={sort}
            onChange={(event) => {
              setSort(event.target.value);
              setViewPref('sort', event.target.value);
            }}
            aria-label="Sort by"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <div className={styles.viewToggle} role="group" aria-label="View">
            <button type="button" className={styles.viewButton} onClick={() => { setView('list'); setViewPref('view', 'list'); }} aria-label="List view" aria-pressed={view === 'list'}>
              <Rows size={16} weight="bold" />
            </button>
            <button type="button" className={styles.viewButton} onClick={() => { setView('grid'); setViewPref('view', 'grid'); }} aria-label="Grid view" aria-pressed={view === 'grid'}>
              <SquaresFour size={16} weight="bold" />
            </button>
          </div>
        </div>
      </div>

      {actionError && <p className={styles.banner} role="alert">{actionError}</p>}
      {listError && <p className={styles.banner} role="alert">{listError}</p>}

      {empty && (
        <div className={styles.empty}>
          <FolderLock size={22} weight="light" className={styles.emptyIcon} />
          <span>{searching ? 'No files match.' : 'There is nothing here.'}</span>
        </div>
      )}

      <div className={styles.area}>
        {items.length > 0 && (
          <FileBrowser items={items} view={view} selection={NO_SELECTION} selectable={false} onOpen={openItem} columns={COLUMNS} menuFor={menuFor} label="Files and folders" />
        )}
      </div>

      {previewIndex !== null && files.length > 0 && (
        <FilePreview
          files={files}
          index={Math.min(previewIndex, files.length - 1)}
          onIndexChange={setPreviewIndex}
          onClose={() => setPreviewIndex(null)}
          readOnly
        />
      )}
    </div>
  );
}

export default EmergencyFilesPage;
