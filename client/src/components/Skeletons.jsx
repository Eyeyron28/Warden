import styles from './Skeletons.module.css';

const bars = (count) => Array.from({ length: count }, (_, index) => index);

/** The content area of a page that has not arrived yet: a title and a few rows. Draws only inside the area. */
export function PageSkeleton({ rows = 6 }) {
  return (
    <div className={styles.page} role="status" aria-busy="true" aria-label="Loading">
      <span className={`${styles.bar} ${styles.title}`} />
      <div className={styles.rows}>
        {bars(rows).map((index) => (
          <div key={index} className={styles.row}>
            <span className={`${styles.bar} ${styles.icon}`} />
            <div className={styles.grow}>
              <span className={styles.bar} style={{ width: `${70 - ((index * 7) % 30)}%` }} />
              <span className={styles.bar} style={{ width: '35%', height: 10 }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A list that is on its way, inside a page that is already on screen. */
export function ListSkeleton({ rows = 6 }) {
  return (
    <div className={styles.rows} role="status" aria-busy="true" aria-label="Loading your files">
      {bars(rows).map((index) => (
        <div key={index} className={styles.row}>
          <span className={`${styles.bar} ${styles.icon}`} />
          <div className={styles.grow}>
            <span className={styles.bar} style={{ width: `${65 - ((index * 9) % 35)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** The signed-in frame (header, sidebar, content) while the stored session is checked: never a blank page. */
export function AppFrameSkeleton() {
  return (
    <div className={styles.frame} aria-busy="true">
      <div className={styles.top}>
        <span className={`${styles.bar} ${styles.icon}`} />
        <span className={styles.bar} style={{ width: 'min(420px, 50%)', height: 32 }} />
      </div>
      <div className={styles.body}>
        <div className={styles.side}>
          {bars(7).map((index) => (
            <span key={index} className={styles.bar} style={{ width: `${80 - ((index * 6) % 28)}%` }} />
          ))}
        </div>
        <div className={styles.main}>
          <PageSkeleton />
        </div>
      </div>
    </div>
  );
}
