import { useCallback, useEffect, useRef, useState } from 'react';
import { CaretRight, Folder } from '@phosphor-icons/react';
import { useNavigate } from 'react-router-dom';

import { listFolderChildren } from '../services/documentsService.js';
import styles from './Sidebar.module.css';

const ancestorsOf = (path) => {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
};

/**
 * The "My files" folder tree. Only one level is fetched at a time: a folder's
 * children load when it is first expanded (and again when `version` changes
 * because folders were added, moved or trashed). The folder being viewed is
 * highlighted and its ancestors are opened for it.
 */
function FolderTree({ current, active, version, onNavigate }) {
  const navigate = useNavigate();
  const [nodes, setNodes] = useState({}); // path -> { folders, loading, error }
  const [expanded, setExpanded] = useState(() => new Set());
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const load = useCallback(async (path) => {
    setNodes((state) => ({ ...state, [path]: { ...state[path], loading: true, error: false } }));
    try {
      const data = await listFolderChildren(path);
      setNodes((state) => ({ ...state, [path]: { folders: data.folders, loading: false, error: false } }));
    } catch (err) {
      if (err?.response?.status === 404 && path !== '') {
        // The folder is gone (trashed or moved): forget it rather than keep asking.
        setNodes((state) => {
          const next = { ...state };
          delete next[path];
          return next;
        });
        setExpanded((state) => {
          const next = new Set(state);
          next.delete(path);
          return next;
        });
        return;
      }
      setNodes((state) => ({ ...state, [path]: { folders: state[path]?.folders ?? [], loading: false, error: true } }));
    }
  }, []);

  // The top level, and every opened folder again when something changed.
  useEffect(() => {
    load('');
    for (const path of expanded) load(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, load]);

  // Opening a folder in the page opens its ancestors in the tree.
  useEffect(() => {
    if (!active) return;
    const needed = ancestorsOf(current);
    if (needed.length === 0) return;
    setExpanded((state) => {
      if (needed.every((path) => state.has(path))) return state;
      return new Set([...state, ...needed]);
    });
    for (const path of needed) {
      if (!nodesRef.current[path]) load(path);
    }
  }, [current, active, load]);

  const toggle = (path) => {
    setExpanded((state) => {
      const next = new Set(state);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!nodesRef.current[path]) load(path);
  };

  const open = (path) => {
    navigate(path ? `/files?path=${encodeURIComponent(path)}` : '/files');
    onNavigate?.();
  };

  const renderLevel = (path, depth) => {
    const node = nodes[path];
    if (!node || !node.folders) return null;
    return (
      <ul className={styles.treeList} role="group">
        {node.folders.map((folder) => {
          const isOpen = expanded.has(folder.path);
          const isCurrent = active && current === folder.path;
          const child = nodes[folder.path];
          return (
            <li key={folder.path} role="treeitem" aria-expanded={folder.hasChildren ? isOpen : undefined} aria-selected={isCurrent}>
              <div className={`${styles.treeRow} ${isCurrent ? styles.treeCurrent : ''}`} style={{ paddingLeft: `${depth * 12}px` }}>
                {folder.hasChildren ? (
                  <button
                    type="button"
                    className={styles.caretButton}
                    onClick={() => toggle(folder.path)}
                    aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${folder.name}`}
                  >
                    <CaretRight size={12} weight="bold" className={isOpen ? styles.caretOpen : ''} />
                  </button>
                ) : (
                  <span className={styles.caretSpacer} />
                )}
                <button
                  type="button"
                  className={styles.treeLink}
                  onClick={() => open(folder.path)}
                  aria-current={isCurrent ? 'page' : undefined}
                  title={folder.name}
                >
                  <Folder size={16} weight={isCurrent ? 'fill' : 'regular'} aria-hidden="true" />
                  <span className={styles.treeName}>{folder.name}</span>
                </button>
              </div>
              {isOpen && (child?.loading && !child.folders ? <p className={styles.treeHint}>Loading…</p> : renderLevel(folder.path, depth + 1))}
            </li>
          );
        })}
      </ul>
    );
  };

  const root = nodes[''];
  return (
    <div className={styles.tree} role="tree" aria-label="Folders">
      {root?.error && !root.folders?.length && <p className={styles.treeHint}>Couldn’t load folders.</p>}
      {root?.loading && !root.folders && <p className={styles.treeHint}>Loading…</p>}
      {root?.folders && root.folders.length === 0 && <p className={styles.treeHint}>No folders yet.</p>}
      {renderLevel('', 0)}
    </div>
  );
}

export default FolderTree;
