import { useCallback, useEffect, useRef, useState } from 'react';
import { CaretRight } from '@phosphor-icons/react';
import { useNavigate } from 'react-router-dom';

import FolderGlyph from './FolderGlyph.jsx';
import { listFolderChildren, peekFolderChildren } from '../services/documentsService.js';
import { dragCarriesDocuments, idsFromDrag, moveDroppedDocuments } from '../utils/dragMove.js';
import { JUST_ASKED_MS } from '../services/dataCache.js';
import styles from './Sidebar.module.css';
import { shortName } from '../utils/ellipsis.js';

const ancestorsOf = (path) => {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
};

function FolderTree({ current, active, version, onNavigate }) {
  const navigate = useNavigate();
  const [nodes, setNodes] = useState(() => {
    const top = peekFolderChildren('');
    return top ? { '': { folders: top.folders, loading: false, error: false } } : {};
  });
  const [expanded, setExpanded] = useState(() => new Set());
  const [dropPath, setDropPath] = useState(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const load = useCallback(async (path, { reuse = false } = {}) => {
    setNodes((state) => ({ ...state, [path]: { ...state[path], loading: true, error: false } }));
    try {
      const data = await listFolderChildren(path, reuse ? { maxAgeMs: JUST_ASKED_MS } : undefined);
      setNodes((state) => ({ ...state, [path]: { folders: data.folders, loading: false, error: false } }));
    } catch (err) {
      if (err?.response?.status === 404 && path !== '') {
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

  useEffect(() => {
    load('', { reuse: version === 0 });
    for (const path of expanded) load(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, load]);

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
              <div
                className={`${styles.treeRow} ${isCurrent ? styles.treeCurrent : ''} ${dropPath === folder.path ? styles.treeDrop : ''}`}
                style={{ paddingLeft: `${depth * 12}px` }}
                onDragOver={(event) => {
                  if (!dragCarriesDocuments(event)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  if (dropPath !== folder.path) setDropPath(folder.path);
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) setDropPath(null);
                }}
                onDrop={(event) => {
                  if (!dragCarriesDocuments(event)) return;
                  event.preventDefault();
                  setDropPath(null);
                  const ids = idsFromDrag(event);
                  if (ids.length) moveDroppedDocuments(ids, folder.path).catch(() => {});
                }}
              >
                {folder.hasChildren ? (
                  <button
                    type="button"
                    className={styles.caretButton}
                    onClick={() => toggle(folder.path)}
                    aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${shortName(folder.name)}`}
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
                  <FolderGlyph icon={folder.icon} color={folder.color} size={16} weight={isCurrent ? 'fill' : 'regular'} />
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
