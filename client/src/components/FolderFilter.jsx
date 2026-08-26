import styles from './FolderFilter.module.css';

/**
 * Folder filter row above the document list. `folders` comes from
 * GET /api/documents/folders (the authoritative distinct-folder list);
 * `counts` is derived client-side from the already-fetched document list
 * - filtering itself is also client-side, there's no per-folder backend
 * endpoint to call here.
 */
function FolderFilter({ folders, counts, activeFolder, onSelect }) {
  return (
    <div className={styles.row} role="tablist" aria-label="Filter by folder">
      <button
        type="button"
        className={`${styles.pill} ${activeFolder === null ? styles.pillActive : ''}`}
        onClick={() => onSelect(null)}
        role="tab"
        aria-selected={activeFolder === null}
      >
        <span>All</span>
        <span className={styles.count}>{counts.total ?? 0}</span>
      </button>

      {folders.map((name) => (
        <button
          key={name}
          type="button"
          className={`${styles.pill} ${activeFolder === name ? styles.pillActive : ''}`}
          onClick={() => onSelect(name)}
          role="tab"
          aria-selected={activeFolder === name}
        >
          <span>{name}</span>
          <span className={styles.count}>{counts[name] ?? 0}</span>
        </button>
      ))}
    </div>
  );
}

export default FolderFilter;
