import { RETENTION } from './retention.js';
import styles from './RetentionTable.module.css';

/** The retention table shown on the privacy page (and in the read-before-you-agree dialog at sign-up). */
function RetentionTable() {
  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <caption className={styles.caption}>How long Warden keeps each kind of data</caption>
        <thead>
          <tr>
            <th scope="col">Data</th>
            <th scope="col">Kept for</th>
          </tr>
        </thead>
        <tbody>
          {RETENTION.map((row) => (
            <tr key={row.what}>
              <th scope="row">{row.what}</th>
              <td>{row.how}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default RetentionTable;
