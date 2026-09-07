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
 * Owner-side pairing UI: generates a pairing code, renders it as a QR,
 * counts down its 5-minute window, and polls GET /api/pair/status/:token
 * every couple seconds so the screen moves from "Waiting for phone..."
 * to "Paired successfully" on its own.
 *
 * The QR encodes a full, directly-openable URL -
 * `http://<LAN host>:<frontend port>/pair/:token?apiBase=...` - rather
 * than a JSON payload for some dedicated in-app scanner: the phone's own
 * native camera app can open it straight into pages/PairPage.jsx with
 * zero Warden-specific scanning code and no new dependency. apiBase is
 * embedded as a query param because the PC's LAN-reachable API address
 * (where PairPage needs to POST the completed pairing) has nothing to
 * do with wherever this frontend itself happens to be hosted.
 *
 * Deliberately NOT window.location.origin here, unlike ShareModal's
 * shareUrl. ShareModal can get away with window.location.origin because
 * a share link's generator and recipient sometimes share an origin (or
 * at least both have a real reason to be on whatever host the owner is
 * browsing from). Pairing is different: it ALWAYS involves two
 * physically different devices, and the owner's own tab is very often
 * open on "localhost:5173" (the natural thing to type on the PC itself)
 * - which means nothing to a phone scanning the code, since "localhost"
 * always resolves to "this device," never "the PC." The QR's host must
 * come from the same LAN-resolved address the backend already computed
 * for apiBase (see resolveApiBase in pairing.controller.js, with its own
 * fail-loudly-if-undetermined guarantee), not from window.location.
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
    // Same host apiBase itself uses (the backend's LAN-resolved address),
    // not window.location.hostname - see the comment above the component
    // for why the owner's own tab (often "localhost") can't be trusted here.
    const lanHost = new URL(apiBase).hostname;
    const port = window.location.port ? `:${window.location.port}` : '';
    // Root cause of a past bug: this used to hardcode "http://" here, so
    // after the app moved to HTTPS the QR kept pointing phones at plain
    // HTTP against a server that no longer spoke it. Using the current
    // page's own protocol keeps this correct automatically whenever the
    // app's scheme changes again, instead of going stale a second time.
    const protocol = window.location.protocol;
    const pairUrl = `${protocol}//${lanHost}${port}/pair/${pairingToken}?apiBase=${encodeURIComponent(apiBase)}`;
    QRCode.toDataURL(pairUrl, { margin: 1, width: 220 })
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
