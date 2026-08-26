import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { CheckCircle, DeviceMobile } from '@phosphor-icons/react';

import { initPairing, getPairingStatus } from '../services/pairingService.js';
import { extractErrorMessage } from '../services/api.js';
import styles from './PairDevicePanel.module.css';

const POLL_INTERVAL_MS = 2500;

function formatCountdown(msRemaining) {
  const totalSeconds = Math.max(0, Math.ceil(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Owner-side pairing UI: generates a pairing code, renders it as a QR
 * (apiBase + pairingToken as JSON - the phone's camera reads this
 * directly, no typing involved), counts down its 5-minute window, and
 * polls GET /api/pair/status/:token every couple seconds so the screen
 * moves from "Waiting for phone..." to "Paired successfully" on its own.
 * Only the PC side - nothing here verifies a phone or completes pairing;
 * that's the next pass.
 */
function PairDevicePanel({ onClose }) {
  const [status, setStatus] = useState('loading'); // loading | waiting | success | expired | error
  const [error, setError] = useState('');
  const [pairingToken, setPairingToken] = useState(null);
  const [apiBase, setApiBase] = useState(null);
  const [expiresAt, setExpiresAt] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [msRemaining, setMsRemaining] = useState(0);

  const pollRef = useRef(null);
  const countdownRef = useRef(null);

  const stopTimers = () => {
    clearInterval(pollRef.current);
    clearInterval(countdownRef.current);
    pollRef.current = null;
    countdownRef.current = null;
  };

  const startPairing = useCallback(async () => {
    stopTimers();
    setStatus('loading');
    setError('');
    setQrDataUrl(null);

    try {
      const result = await initPairing();
      setPairingToken(result.pairingToken);
      setApiBase(result.apiBase);
      setExpiresAt(result.expiresAt);
      setStatus('waiting');
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not start pairing.'));
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    startPairing();
    return stopTimers;
  }, [startPairing]);

  // Renders the QR client-side (qrcode npm package, same as document
  // sharing) whenever a fresh pairing code is issued.
  useEffect(() => {
    if (!pairingToken || !apiBase) {
      setQrDataUrl(null);
      return undefined;
    }

    let cancelled = false;
    const payload = JSON.stringify({ apiBase, pairingToken });
    QRCode.toDataURL(payload, { margin: 1, width: 220 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [pairingToken, apiBase]);

  // Countdown + status polling, only while actively waiting on a code.
  useEffect(() => {
    if (status !== 'waiting' || !pairingToken || !expiresAt) return undefined;

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
        const result = await getPairingStatus(pairingToken);
        if (result.used) {
          setStatus('success');
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
  }, [status, pairingToken, expiresAt]);

  return (
    <div className={styles.panel}>
      {status === 'loading' && <p className={styles.hint}>Generating pairing code...</p>}

      {status === 'error' && (
        <>
          <p className={styles.error} role="alert">
            {error}
          </p>
          <div className={styles.buttonRow}>
            <button type="button" className={styles.cancelButton} onClick={onClose}>
              Cancel
            </button>
            <button type="button" className={styles.submitButton} onClick={startPairing}>
              Try again
            </button>
          </div>
        </>
      )}

      {status === 'waiting' && (
        <>
          <p className={styles.instructions}>
            Scan this code with the Warden app on your phone to pair it with this vault.
          </p>

          {qrDataUrl && (
            <div className={styles.qrWrap}>
              <img src={qrDataUrl} alt="Pairing QR code" className={styles.qrImage} />
            </div>
          )}

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
          <div className={styles.expiredBanner}>
            <DeviceMobile size={20} weight="light" className={styles.expiredIcon} />
            <p>This pairing code expired before a phone used it.</p>
          </div>
          <div className={styles.buttonRow}>
            <button type="button" className={styles.cancelButton} onClick={onClose}>
              Cancel
            </button>
            <button type="button" className={styles.submitButton} onClick={startPairing}>
              Generate a new code
            </button>
          </div>
        </>
      )}

      {status === 'success' && (
        <>
          <div className={styles.successBanner}>
            <CheckCircle size={20} weight="fill" className={styles.successIcon} />
            <div className={styles.successCopy}>
              <p className={styles.successTitle}>Paired successfully</p>
              <p className={styles.successBody}>Your phone is now paired with this vault.</p>
            </div>
          </div>
          <div className={styles.buttonRow}>
            <button type="button" className={styles.cancelButton} onClick={onClose}>
              Done
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default PairDevicePanel;
