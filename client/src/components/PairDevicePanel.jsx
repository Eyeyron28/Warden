import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { CheckCircle } from '@phosphor-icons/react';

import OtpChallengePanel from './OtpChallengePanel.jsx';
import { requestPairCode, resendPairCode, initPairing, getPairingStatus } from '../services/pairingService.js';
import { extractErrorMessage } from '../services/api.js';
import { pairingUrl } from '../utils/phoneUrls.js';
import styles from '../pages/DevicesPage.module.css';

const POLL_INTERVAL_MS = 2500;

function formatCountdown(msRemaining) {
  const totalSeconds = Math.max(0, Math.ceil(msRemaining / 1000));
  return `${Math.floor(totalSeconds / 60)}:${(totalSeconds % 60).toString().padStart(2, '0')}`;
}

/**
 * Owner-side pairing: ask for a code (emailed to the account), enter it, and a
 * 5-minute QR appears. A stolen session alone cannot pair a phone because the
 * code goes to the mailbox. The QR holds `<public origin>/pair/<token>`: the
 * server's validated PUBLIC_APP_URL in production, this page's own origin in
 * development - never an address found on the network.
 *
 * Steps: idle -> code (emailed code) -> qr (countdown, polling) -> success |
 * expired. Generating a new QR always starts again from the emailed code.
 */
function PairDevicePanel({ onPaired }) {
  const [step, setStep] = useState('idle'); // idle | sending | code | qr | success | expired
  const [error, setError] = useState('');
  const [challenge, setChallenge] = useState(null);
  const [pairing, setPairing] = useState(null); // { token, expiresAt }
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [msRemaining, setMsRemaining] = useState(0);
  const timers = useRef({ poll: null, tick: null });

  const stopTimers = () => {
    clearInterval(timers.current.poll);
    clearInterval(timers.current.tick);
    timers.current = { poll: null, tick: null };
  };
  useEffect(() => stopTimers, []);

  const askForCode = useCallback(async () => {
    stopTimers();
    setError('');
    setStep('sending');
    setPairing(null);
    setQrDataUrl(null);
    try {
      setChallenge(await requestPairCode());
      setStep('code');
    } catch (err) {
      setError(extractErrorMessage(err, 'We couldn’t send the code. Please try again.'));
      setStep('idle');
    }
  }, []);

  // Render the QR whenever a pairing code is issued.
  useEffect(() => {
    if (!pairing) return undefined;
    let cancelled = false;
    QRCode.toDataURL(pairing.url, { margin: 1, width: 400 })
      .then((url) => !cancelled && setQrDataUrl(url))
      .catch(() => !cancelled && setQrDataUrl(null));
    return () => {
      cancelled = true;
    };
  }, [pairing]);

  // Countdown and status polling while the QR is on screen.
  useEffect(() => {
    if (step !== 'qr' || !pairing) return undefined;
    const expiresAtMs = new Date(pairing.expiresAt).getTime();
    const tick = () => {
      const remaining = expiresAtMs - Date.now();
      setMsRemaining(remaining);
      if (remaining <= 0) {
        setStep('expired');
        stopTimers();
      }
    };
    tick();
    timers.current.tick = setInterval(tick, 1000);
    timers.current.poll = setInterval(async () => {
      try {
        const result = await getPairingStatus(pairing.token);
        if (result.used) {
          setStep('success');
          stopTimers();
          onPaired?.();
        } else if (result.expired) {
          setStep('expired');
          stopTimers();
        }
      } catch {
        // A hiccup while polling must not kill the QR on screen; the next tick tries again.
      }
    }, POLL_INTERVAL_MS);
    return stopTimers;
  }, [step, pairing, onPaired]);

  return (
    <div className={styles.pairBody}>
      {error && <p className={styles.error} role="alert">{error}</p>}

      {(step === 'idle' || step === 'sending') && (
        <>
          <p className={styles.text}>
            To add a phone, we email a code to your account first, so nobody who only has your open browser can pair one. Then a QR
            code appears for the phone to scan.
          </p>
          <button type="button" className={styles.primary} onClick={askForCode} disabled={step === 'sending'}>
            {step === 'sending' ? 'Sending the code…' : 'Email me a code'}
          </button>
        </>
      )}

      {step === 'code' && challenge && (
        <div className={styles.otpWrap}>
          <p className={styles.small}>We emailed you a six-digit code. It only works for pairing a device.</p>
          <OtpChallengePanel
            challenge={challenge}
            onSubmitCode={async (code, token) => initPairing(token, code)}
            onResend={(token) => resendPairCode(token)}
            onVerified={(result) => {
              setPairing({
                token: result.pairingToken,
                expiresAt: result.expiresAt,
                url: pairingUrl(result.appUrl, result.pairingToken),
              });
              setStep('qr');
            }}
            onBack={() => setStep('idle')}
            onDead={(message) => {
              setError(message);
              setStep('idle');
            }}
            submitLabel="Show the QR code"
          />
        </div>
      )}

      {step === 'qr' && (
        <>
          <p className={styles.text}>Scan this with your phone’s camera and follow the steps there. You will need your master password.</p>
          <div className={styles.qrBlock}>
            <div className={styles.qrWrap}>{qrDataUrl && <img src={qrDataUrl} alt="Pairing QR code" className={styles.qrImage} />}</div>
            <div className={styles.qrSide}>
              <p className={styles.countdown} role="timer" aria-live="off">Expires in {formatCountdown(msRemaining)}</p>
              <p className={styles.waiting}>Waiting for the phone…</p>
              <button type="button" className={styles.secondary} onClick={askForCode}>
                New code
              </button>
              <p className={styles.small}>A new QR needs a new emailed code.</p>
            </div>
          </div>
        </>
      )}

      {step === 'expired' && (
        <>
          <p className={styles.text} role="status">That code expired before a phone used it.</p>
          <button type="button" className={styles.primary} onClick={askForCode}>
            Email me a new code
          </button>
        </>
      )}

      {step === 'success' && (
        <>
          <div className={styles.banner} role="status">
            <CheckCircle size={20} weight="fill" className={styles.bannerIcon} />
            <div>
              <p className={styles.bannerTitle}>Paired successfully</p>
              <p className={styles.text}>The phone is now in the list below. We also emailed you about it.</p>
            </div>
          </div>
          <button type="button" className={styles.secondary} onClick={() => setStep('idle')}>
            Pair another phone
          </button>
        </>
      )}
    </div>
  );
}

export default PairDevicePanel;
