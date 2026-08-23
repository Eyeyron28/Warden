import { useNavigate } from 'react-router-dom';
import { FolderLock } from '@phosphor-icons/react';

import Header from '../components/Header.jsx';
import styles from './VaultShell.module.css';

function VaultShell() {
  const navigate = useNavigate();

  return (
    <div className={styles.shell}>
      <Header onLock={() => navigate('/')} />

      <main className={styles.content}>
        <div className={styles.emptyState}>
          <FolderLock size={40} weight="light" className={styles.emptyIcon} />
          <h2 className={styles.emptyTitle}>Your vault is empty</h2>
          <p className={styles.emptyBody}>
            Document upload and folder management will live here next.
          </p>
        </div>
      </main>
    </div>
  );
}

export default VaultShell;
