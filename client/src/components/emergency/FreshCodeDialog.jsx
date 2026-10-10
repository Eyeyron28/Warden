import { useEffect, useRef, useState } from 'react';

import Modal from '../Modal.jsx';
import OtpChallengePanel from '../OtpChallengePanel.jsx';
import { extractErrorMessage } from '../../services/api.js';
import { resendOwnerCode, startOwnerCode } from '../../services/emergencyService.js';
import styles from './emergency.module.css';

/**
 * The fresh emailed code every Emergency Access change needs. It asks the server to email a code for ONE action
 * ('setup' | 'regenerate' | 'revoke' | 'approve-now'), shows the six-box code entry, and hands `{ challengeToken,
 * code }` to `onVerified`. The server checks the code when the action itself runs (a code made for another action
 * is refused there), so a wrong code comes back from that call and the caller can reopen this dialog.
 */
function FreshCodeDialog({ action, title, intro, onVerified, onClose }) {
  const [challenge, setChallenge] = useState(null);
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    startOwnerCode(action)
      .then(setChallenge)
      .catch((err) => setError(extractErrorMessage(err, 'We couldn’t send the code email. Please try again in a moment.')));
  }, [action]);

  return (
    <Modal title={title} onClose={onClose}>
      <div className={styles.codeDialog}>
        {intro && <p className={styles.muted}>{intro}</p>}
        {!challenge && !error && <p className={styles.muted} role="status">Sending a code to your email…</p>}
        {error && (
          <>
            <p className={styles.error} role="alert">{error}</p>
            <div className={styles.actions}>
              <button type="button" className={styles.secondary} onClick={onClose}>Close</button>
            </div>
          </>
        )}
        {challenge && (
          <OtpChallengePanel
            challenge={challenge}
            onSubmitCode={async (code, token) => ({ challengeToken: token, code })}
            onResend={resendOwnerCode}
            onVerified={onVerified}
            onBack={onClose}
            onDead={(message) => {
              setChallenge(null);
              setError(message);
            }}
            submitLabel="Continue"
            busyLabel="Checking…"
          />
        )}
      </div>
    </Modal>
  );
}

export default FreshCodeDialog;
