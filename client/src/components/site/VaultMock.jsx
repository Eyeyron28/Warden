import Icon from './Icon.jsx';
import styles from './VaultMock.module.css';

const FOLDERS = [
  { name: 'Identity', count: 3, active: true },
  { name: 'Taxes', count: 7 },
  { name: 'Housing', count: 2 },
  { name: 'Medical', count: 4 },
];

const FILES = [
  { name: 'lease-2026.pdf', size: '1.2 MB', date: 'Mar 04' },
  { name: 'tin-certificate.png', size: '640 KB', date: 'Jan 18' },
];

/**
 * A small, CSS-built stand-in for the real vault screen (not a stock
 * illustration). Purely decorative for screen readers - the hero copy
 * says everything this shows - so it's a single labelled image.
 *
 * One idle animation: the passport row's preview crossfades between its
 * readable text and the ciphertext that's actually stored. Slow (9s per
 * cycle), and frozen on the "encrypted" frame with reduced motion.
 */
function VaultMock() {
  return (
    <div
      className={styles.frame}
      role="img"
      aria-label="Preview of the Warden vault: an Identity folder with an encrypted passport scan, a lease and a tax certificate."
    >
      <div className={styles.titleBar} aria-hidden="true">
        <span className={styles.dots}>
          <span />
          <span />
          <span />
        </span>
        <span className={styles.path}>My Vault / Identity</span>
        <span className={styles.status}>
          <Icon name="lock" size={13} />
          Locked at rest
        </span>
      </div>

      <div className={styles.body} aria-hidden="true">
        <ul className={styles.folders}>
          {FOLDERS.map((folder) => (
            <li key={folder.name} className={folder.active ? styles.folderActive : styles.folder}>
              <Icon name="folder" size={15} />
              <span>{folder.name}</span>
              <span className={styles.count}>{folder.count}</span>
            </li>
          ))}
        </ul>

        <ul className={styles.files}>
          <li className={`${styles.file} ${styles.liveFile}`}>
            <Icon name="file" size={16} className={styles.fileIcon} />
            <div className={styles.fileMeta}>
              <span className={styles.fileName}>passport-scan.pdf</span>
              <span className={styles.preview}>
                <span className={styles.plain}>REPUBLIC OF THE PHILIPPINES · PASSPORT</span>
                <span className={styles.cipher}>9f3a c1e8 77b0 2d4f e6a1 0c93 b85d</span>
              </span>
            </div>
            <span className={styles.chip}>
              <Icon name="lock" size={12} />
              <span className={styles.chipPlain}>Encrypting</span>
              <span className={styles.chipCipher}>AES-256</span>
            </span>
          </li>
          {FILES.map((file) => (
            <li key={file.name} className={styles.file}>
              <Icon name="file" size={16} className={styles.fileIcon} />
              <div className={styles.fileMeta}>
                <span className={styles.fileName}>{file.name}</span>
                <span className={styles.fileSub}>
                  {file.size} · {file.date}
                </span>
              </div>
              <span className={styles.lockOnly}>
                <Icon name="lock" size={14} />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default VaultMock;
