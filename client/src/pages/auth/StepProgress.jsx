import Icon from '../../components/site/Icon.jsx';
import styles from './StepProgress.module.css';

function StepProgress({ current, labels = ['Email', 'Code', 'New password'] }) {
  return (
    <ol className={styles.progress} aria-label={`Progress: step ${current} of ${labels.length}`}>
      {labels.map((label, index) => {
        const number = index + 1;
        const state = number < current ? styles.done : number === current ? styles.current : '';
        return (
          <li key={label} className={`${styles.step} ${state}`} aria-current={number === current ? 'step' : undefined}>
            <span className={styles.marker} aria-hidden="true">
              {number < current ? <Icon name="check" size={14} /> : number}
            </span>
            <span className={styles.label}>
              <span className={styles.srOnly}>{number < current ? 'Done: ' : number === current ? 'Current step: ' : 'Next: '}</span>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export default StepProgress;
