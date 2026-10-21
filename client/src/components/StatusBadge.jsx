import styles from './StatusBadge.module.css';

function StatusBadge({ label, tone = 'neutral', dot = false }) {
  return (
    <span className={`${styles.badge} ${styles[tone]}`}>
      {dot && <span className={styles.dot} />}
      {label}
    </span>
  );
}

export default StatusBadge;
