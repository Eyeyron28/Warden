import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { ArrowRight, CheckCircle } from '@phosphor-icons/react';

import Modal from './Modal.jsx';
import PasswordField from './PasswordField.jsx';
import PasswordStrengthMeter from './PasswordStrengthMeter.jsx';
import { initPhoneRecovery, getPhoneRecoveryStatus, completePhoneRecovery } from '../services/authService.js';
import { extractErrorMessage } from '../services/api.js';
import { validatePassword } from '../utils/passwordPolicy.js';
import styles from './PhoneRecoveryModal.module.css';

const POLL_INTERVAL_MS = 2500;

function formatCountdown(msRemaining) {
  const totalSeconds = Math.max(0, Math.ceil(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * LockScreen's "Recover with paired phone" entry point. Same generate
 * code -> show QR -> poll status shape as PairDevicePanel, plus a final
 * step once the phone responds: choosing the new master password. The
 * phone never sends its raw DEK here - only the wrapped material POST
 * /api/auth/recover-via-phone/submit already stored server-side; this
 * component only ever holds `recoveryToken` (which IS the credential,
 * same trust model as PairDevicePanel's pairingToken).
 */
function PhoneRecoveryModal({ onClose, onRecovered }) {
  const [status, setStatus] = useState('loading'); // loading | waiting | fulfilled | expired | error
  const [error, setError] = useState('');
  const [recoveryToken, setRecoveryToken] = useState(null);
  const [recoverUrl, setRecoverUrl] = useState(null);
  const [expiresAt, setExpiresAt] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [msRemaining, setMsRemaining] = useState(0);

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [confirmError, setConfirmError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const pollRef = useRef(null);
  const countdownRef = useRef(null);

  const stopTimers = () => {
    clearInterval(pollRef.current);
    clearInterval(countdownRef.current);
    pollRef.current = null;
    countdownRef.current = null;
  };

  const start = useCallback(async () => {
    stopTimers();
    setStatus('loading');
    setError('');
    setQrDataUrl(null);

    try {
      const result = await initPhoneRecovery();
      setRecoveryToken(result.recoveryToken);
      setRecoverUrl(result.recoverUrl);
      setExpiresAt(result.expiresAt);
      setStatus('waiting');
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not start phone recovery.'));
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    start();
    return stopTimers;
  }, [start]);

  // QR encodes recoverUrl (the phone's camera opens straight into
  // PhoneVault with the token pre-filled) when the server could
  // determine its own LAN IP; otherwise there's nothing useful to
  // encode, and the raw recoveryToken text below is the only path.
  useEffect(() => {
    if (!recoverUrl) {
      setQrDataUrl(null);
      return undefined;
    }

    let cancelled = false;
    QRCode.toDataURL(recoverUrl, { margin: 1, width: 200 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [recoverUrl]);

  useEffect(() => {
    if (status !== 'waiting' || !recoveryToken || !expiresAt) return undefined;

    const expiresAtMs = new Date(expiresAt).getTime();

    const tick = () => {
      const remaining = expiresAtMs - Date.now();
      setMsRemaining(remaining);
      if (remaining <= 0) {
        setStatus('expired');
        stopTimers();
      }
    };
    tick();
    countdownRef.current = setInterval(tick, 1000);

    const poll = async () => {
      try {
        const result = await getPhoneRecoveryStatus(recoveryToken);
        if (result.fulfilled) {
          setStatus('fulfilled');
          stopTimers();
        } else if (result.expired) {
          setStatus('expired');
          stopTimers();
        }
      } catch {
        // A transient network hiccup while polling shouldn't kill the QR
        // already on screen - just try again on the next interval.
      }
    };
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return stopTimers;
  }, [status, recoveryToken, expiresAt]);

  const policy = validatePassword(newPassword);
  const canSubmit =
    policy.valid && confirmPassword.length > 0 && newPassword === confirmPassword && !submitting;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!canSubmit) return;

    setConfirmError('');
    if (newPassword !== confirmPassword) {
      setConfirmError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const { sessionToken } = await completePhoneRecovery(recoveryToken, newPassword);
      onRecovered(sessionToken);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not complete recovery.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Recover with paired phone" onClose={onClose}>
      <div className={styles.panel}>
        {status === 'loading' && <p className={styles.hint}>Generating recovery code...</p>}

        {status === 'error' && (
          <>
            <p className={styles.error} role="alert">
              {error}
            </p>
            <div className={styles.buttonRow}>
              <button type="button" className={styles.cancelButton} onClick={onClose}>
                Cancel
              </button>
              <button type="button" className={styles.submitButton} onClick={start}>
                Try again
              </button>
            </div>
          </>
        )}

        {status === 'waiting' && (
          <>
            <p className={styles.instructions}>
              On your paired phone, unlock it with your PIN, then choose "Help recover PC vault"
              {recoverUrl ? ' - scanning this code opens it directly.' : ' and enter this code:'}
            </p>

            {qrDataUrl && (
              <div className={styles.qrWrap}>
                <img src={qrDataUrl} alt="Recovery QR code" className={styles.qrImage} />
              </div>
            )}

            <p className={styles.code}>{recoveryToken}</p>

            <p className={styles.countdown}>Expires in {formatCountdown(msRemaining)}</p>
            <p className={styles.waitingLine}>Waiting for phone...</p>

            <div className={styles.buttonRow}>
              <button type="button" className={styles.cancelButton} onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}

        {status === 'expired' && (
          <>
            <p className={styles.hint}>This recovery code expired before a phone used it.</p>
            <div className={styles.buttonRow}>
              <button type="button" className={styles.cancelButton} onClick={onClose}>
                Cancel
              </button>
              <button type="button" className={styles.submitButton} onClick={start}>
                Generate a new code
              </button>
            </div>
          </>
        )}

        {status === 'fulfilled' && (
          <>
            <div className={styles.successBanner}>
              <CheckCircle size={20} weight="fill" className={styles.successIcon} />
              <p>Your phone confirmed the request. Choose a new master password to finish.</p>
            </div>

            <form className={styles.form} onSubmit={handleSubmit} noValidate>
              <PasswordField
                label="New master password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter a new strong password"
                error={error}
                autoFocus
              />

              <PasswordStrengthMeter password={newPassword} />

              <PasswordField
                label="Confirm new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
                error={confirmError}
              />

              <button type="submit" className={styles.primaryButton} disabled={!canSubmit}>
                <span>{submitting ? 'Recovering...' : 'Recover vault'}</span>
                <ArrowRight size={18} weight="bold" />
              </button>
            </form>
          </>
        )}
      </div>
    </Modal>
  );
}

export default PhoneRecoveryModal;
