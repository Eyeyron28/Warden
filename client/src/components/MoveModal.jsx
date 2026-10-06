import { useMemo, useRef, useState } from 'react';
import { CaretRight, CheckCircle, Folder, FolderSimplePlus, House, WarningCircle } from '@phosphor-icons/react';

import Modal from './Modal.jsx';
import { createFolder, moveItems } from '../services/documentsService.js';
import { extractErrorMessage } from '../services/api.js';
import { getImmediateChildren, joinPath, splitPath } from '../utils/folderPath.js';
import styles from './MoveModal.module.css';

const ROOT_LABEL = 'My Vault';

function isSameOrDescendant(path, ancestor) {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

/**
 * "Move to..." picker. Browses the folder tree breadcrumb-style starting
 * from wherever the vault is currently showing; "Move here" sends the
 * whole selection to the folder being browsed.
 *
 * - `currentLocation` (the folder the items already live in, when they all
 *   share one) is marked, and "Move here" is disabled while browsing it.
 * - `movingFolders` (folders that are part of the selection) are shown but
 *   can't be entered - a folder can't be moved into itself or its own
 *   subfolders (the server enforces this too).
 * - A partial result (some items conflicted) keeps the dialog open and
 *   lists every item that didn't move, with the server's reason.
 */
function MoveModal({
  items,
  title,
  folderPaths,
  startPath,
  currentLocation,
  movingFolders = [],
  onClose,
  onMoved,
  onFolderCreated,
}) {
  const [browsePath, setBrowsePath] = useState(
    movingFolders.some((folder) => isSameOrDescendant(startPath, folder)) ? '' : startPath
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState('');
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [extraPaths, setExtraPaths] = useState([]);
  const newNameRef = useRef(null);

  const allPaths = useMemo(() => {
    const set = new Set();
    for (const path of [...folderPaths, ...extraPaths]) {
      if (path && path !== 'root') set.add(path);
    }
    return set;
  }, [folderPaths, extraPaths]);

  const children = useMemo(() => getImmediateChildren(allPaths, browsePath), [allPaths, browsePath]);
  const segments = splitPath(browsePath);
  const isCurrentLocation = currentLocation !== null && currentLocation !== undefined && browsePath === currentLocation;
  const destinationLabel = browsePath || ROOT_LABEL;

  const handleMove = async () => {
    if (submitting || isCurrentLocation) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await moveItems(items, browsePath);
      const failed = response.results.filter((entry) => !['moved', 'unchanged'].includes(entry.status));
      if (failed.length === 0) {
        onMoved(response, { close: true });
      } else {
        onMoved(response, { close: false });
        setResult(response);
      }
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not move these items.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreate = async (event) => {
    event.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed || createSubmitting) return;
    if (/[\\/]/.test(trimmed)) {
      setCreateError('Folder names can\'t contain "/" or "\\".');
      return;
    }
    setCreateSubmitting(true);
    setCreateError('');
    try {
      const { name: createdPath } = await createFolder(joinPath([...segments, trimmed]));
      setExtraPaths((prev) => [...prev, createdPath]);
      onFolderCreated?.(createdPath);
      setCreating(false);
      setNewName('');
      setBrowsePath(createdPath);
    } catch (err) {
      setCreateError(extractErrorMessage(err, 'Could not create this folder.'));
      requestAnimationFrame(() => newNameRef.current?.focus());
    } finally {
      setCreateSubmitting(false);
    }
  };

  if (result) {
    const moved = result.results.filter((entry) => entry.status === 'moved');
    const notMoved = result.results.filter((entry) => !['moved', 'unchanged'].includes(entry.status));
    return (
      <Modal title={title} onClose={onClose}>
        <div className={styles.panel}>
          <p className={styles.summary}>
            {moved.length > 0
              ? `Moved ${moved.length} item${moved.length === 1 ? '' : 's'} to ${result.destination || ROOT_LABEL}.`
              : 'Nothing was moved.'}{' '}
            {notMoved.length} item{notMoved.length === 1 ? '' : 's'} could not be moved:
          </p>
          <ul className={styles.resultList}>
            {notMoved.map((entry) => (
              <li key={entry.id || entry.path} className={styles.resultItem}>
                <WarningCircle size={16} weight="fill" className={styles.resultIconBad} aria-hidden="true" />
                <span>
                  <strong>{entry.name || entry.path || 'Item'}</strong> - {entry.message}
                </span>
              </li>
            ))}
            {moved.map((entry) => (
              <li key={entry.id || entry.path} className={styles.resultItem}>
                <CheckCircle size={16} weight="fill" className={styles.resultIconGood} aria-hidden="true" />
                <span>
                  <strong>{entry.name}</strong> - moved
                </span>
              </li>
            ))}
          </ul>
          <div className={styles.footer}>
            <button type="button" className={styles.primaryButton} onClick={onClose} autoFocus>
              Done
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className={styles.panel}>
        <nav className={styles.breadcrumb} aria-label="Destination folder">
          <button
            type="button"
            className={styles.crumb}
            onClick={() => setBrowsePath('')}
            aria-current={segments.length === 0 ? 'location' : undefined}
            autoFocus
          >
            <House size={14} weight="bold" aria-hidden="true" />
            <span>{ROOT_LABEL}</span>
          </button>
          {segments.map((segment, index) => {
            const segmentPath = joinPath(segments.slice(0, index + 1));
            return (
              <span key={segmentPath} className={styles.crumbGroup}>
                <CaretRight size={12} weight="bold" className={styles.separator} aria-hidden="true" />
                <button
                  type="button"
                  className={styles.crumb}
                  onClick={() => setBrowsePath(segmentPath)}
                  aria-current={index === segments.length - 1 ? 'location' : undefined}
                >
                  {segment}
                </button>
              </span>
            );
          })}
        </nav>

        <ul className={styles.folderList} aria-label={`Folders in ${destinationLabel}`}>
          {children.length === 0 && <li className={styles.emptyHint}>No folders here.</li>}
          {children.map((name) => {
            const childPath = joinPath([...segments, name]);
            const beingMoved = movingFolders.some((folder) => isSameOrDescendant(childPath, folder));
            return (
              <li key={childPath}>
                <button
                  type="button"
                  className={styles.folderButton}
                  onClick={() => setBrowsePath(childPath)}
                  disabled={beingMoved}
                  aria-label={beingMoved ? `${name} (being moved)` : `Open ${name}`}
                >
                  <Folder size={18} weight="fill" className={styles.folderIcon} aria-hidden="true" />
                  <span className={styles.folderName}>{name}</span>
                  {beingMoved ? (
                    <span className={styles.folderNote}>Being moved</span>
                  ) : (
                    <CaretRight size={14} weight="bold" className={styles.folderCaret} aria-hidden="true" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        {creating ? (
          <form className={styles.newFolderForm} onSubmit={handleCreate} noValidate>
            <label htmlFor="move-new-folder" className={styles.srOnly}>
              New folder name
            </label>
            <input
              ref={newNameRef}
              id="move-new-folder"
              type="text"
              className={styles.textInput}
              value={newName}
              onChange={(event) => {
                setNewName(event.target.value);
                if (createError) setCreateError('');
              }}
              placeholder={`New folder in ${destinationLabel}`}
              maxLength={100}
              disabled={createSubmitting}
              aria-invalid={Boolean(createError)}
              aria-describedby="move-new-folder-error"
              autoFocus
            />
            <div className={styles.newFolderButtons}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => {
                  setCreating(false);
                  setNewName('');
                  setCreateError('');
                }}
                disabled={createSubmitting}
              >
                Cancel
              </button>
              <button type="submit" className={styles.secondaryButton} disabled={!newName.trim() || createSubmitting}>
                {createSubmitting ? 'Creating...' : 'Create'}
              </button>
            </div>
            <p id="move-new-folder-error" className={styles.error} role="alert" aria-live="assertive">
              {createError || ' '}
            </p>
          </form>
        ) : (
          <button type="button" className={styles.newFolderButton} onClick={() => setCreating(true)}>
            <FolderSimplePlus size={16} weight="bold" aria-hidden="true" />
            <span>New folder</span>
          </button>
        )}

        <p className={styles.error} role="alert">
          {error || ' '}
        </p>

        <div className={styles.footer}>
          <span className={styles.locationNote}>
            {isCurrentLocation ? 'This is the current location.' : `Destination: ${destinationLabel}`}
          </span>
          <div className={styles.footerButtons}>
            <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={handleMove}
              disabled={submitting || isCurrentLocation}
            >
              {submitting ? 'Moving...' : 'Move here'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export default MoveModal;
