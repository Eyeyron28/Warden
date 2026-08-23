import styles from './StatusBadge.module.css';

/**
 * Small mono-type pill for technical / state readouts (e.g. "AES-256",
 * "Local instance", "Unlocked"). The dot is shown only when it conveys
 * a real semantic state, not as decoration.
 */
function StatusBadge({ label, tone = 'neutral', dot = false }) {
  return (
    <span className={`${styles.badge} ${styles[tone]}`}>
      {dot && <span className={styles.dot} />}
      {label}
    </span>
  );
}

export default StatusBadge;
