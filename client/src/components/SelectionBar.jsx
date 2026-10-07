import styles from './SelectionBar.module.css';

/**
 * The page's header bar while anything is selected: the count, the actions
 * for exactly the selected items, and Clear. `actions` are
 * `{ key, label, icon, onClick, disabled?, title?, danger? }`.
 */
function SelectionBar({ count, actions, onClear }) {
  return (
    <div className={styles.bar} role="toolbar" aria-label="Actions for selected items">
      <span className={styles.count} role="status" aria-live="polite">
        {count} selected
      </span>
      <div className={styles.actions}>
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            className={`${styles.action} ${action.danger ? styles.danger : ''}`}
            onClick={action.onClick}
            disabled={action.disabled}
            title={action.title}
            aria-label={action.label}
          >
            {action.icon}
            <span className={styles.label}>{action.label}</span>
          </button>
        ))}
        <button type="button" className={`${styles.action} ${styles.clear}`} onClick={onClear}>
          Clear
        </button>
      </div>
    </div>
  );
}

export default SelectionBar;
