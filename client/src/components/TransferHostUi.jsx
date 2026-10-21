import Modal from './Modal.jsx';
import TransferTray from './TransferTray.jsx';
import { transfers, useTransfers } from '../services/transfers.js';
import styles from './TransferTray.module.css';

function TransferHostUi() {
  const t = useTransfers();
  return (
    <>
      <TransferTray />
      {t.signOutPrompt?.confirm && (
        <Modal
          title="Log out?"
          onClose={() => transfers.answerSignOut(false)}
          footer={
            <>
              <button type="button" className={styles.dialogPlain} onClick={() => transfers.answerSignOut(false)} autoFocus>
                Cancel
              </button>
              <button type="button" className={styles.dialogDanger} onClick={() => transfers.answerSignOut(true)}>
                Log out
              </button>
            </>
          }
        >
          <p className={styles.dialogText}>You will be signed out on this device. Your files stay in your vault.</p>
          {t.signOutPrompt.working && (
            <p className={styles.dialogHint}>Files still being sealed will be stopped. Files already sealed stay in your vault.</p>
          )}
        </Modal>
      )}
      {t.signOutPrompt && !t.signOutPrompt.confirm && (
        <Modal
          title="Stop and sign out?"
          onClose={() => transfers.answerSignOut(false)}
          footer={
            <>
              <button type="button" className={styles.dialogPlain} onClick={() => transfers.answerSignOut(false)}>
                Keep going
              </button>
              <button type="button" className={styles.dialogDanger} onClick={() => transfers.answerSignOut(true)}>
                Stop and sign out
              </button>
            </>
          }
        >
          <p className={styles.dialogText}>{t.signOutPrompt.text}</p>
          <p className={styles.dialogHint}>Files that were already sealed or imported stay in your vault. Nothing is undone.</p>
        </Modal>
      )}
    </>
  );
}

export default TransferHostUi;
