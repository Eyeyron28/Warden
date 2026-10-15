import ImportCard from './ImportCard.jsx';
import Modal from './Modal.jsx';
import { SIGN_OUT_PROMPT, importJob, useImportJob } from '../services/importJob.js';
import styles from './ImportCard.module.css';

/**
 * Everything the import job puts on screen: the card, and the question asked when someone presses Lock vault or Log out while an
 * import is running. Loaded the first time a job exists (components/ImportHost.jsx), so it is not part of the main bundle.
 */
function ImportHostUi() {
  const state = useImportJob();
  return (
    <>
      <ImportCard />
      {state.signOutPrompt && (
        <Modal
          title="Stop the import?"
          onClose={() => importJob.answerSignOut(false)}
          footer={
            <>
              <button type="button" className={styles.dialogPlain} onClick={() => importJob.answerSignOut(false)}>
                Keep importing
              </button>
              <button type="button" className={styles.dialogDanger} onClick={() => importJob.answerSignOut(true)}>
                Stop and sign out
              </button>
            </>
          }
        >
          <p className={styles.dialogText}>{SIGN_OUT_PROMPT}</p>
          <p className={styles.dialogHint}>Files that were already imported stay in your vault. The import is not undone.</p>
        </Modal>
      )}
    </>
  );
}

export default ImportHostUi;
