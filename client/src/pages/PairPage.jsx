import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { ArrowRight, CheckCircle, LinkBreak } from '@phosphor-icons/react';

import wardenLogo from '../assets/warden_logo_badge.svg';
import PasswordField from '../components/PasswordField.jsx';
import { completePairing } from '../services/pairCompleteService.js';
import { saveDeviceAuthLocally } from '../services/localVault.js';
import { extractErrorMessage } from '../services/api.js';
import styles from './PairPage.module.css';

const MIN_PHONE_PIN_LENGTH = 4;

/**
 * The phone-side pairing page (/pair/:token), opened by scanning the QR
 * PairDevicePanel shows on the PC. Lives entirely outside the vault's
 * auth flow - same spirit as SharedDocumentPage - since a phone that's
 * never paired before has no session, no local vault data, nothing.
 *
 * The QR encodes a full, directly-openable URL
 * (`${origin}/pair/:token?apiBase=...`) rather than a JSON payload for a
 * dedicated in-app scanner: the phone's own native camera app can open
 * it with no Warden-specific scanning code needed, and no new
 * dependency (see PairDevicePanel for where that URL is built). apiBase
 * is read from the query string since the PC that generated it may be
 * on a different LAN address than wherever this page itself is hosted.
 */
function PairPage() {
  const { token } = useParams();
  const [searchParams] = useSearchParams();
  const apiBase = searchParams.get('apiBase') || window.location.origin;

  const [masterPassword, setMasterPassword] = useState('');
  const [phonePin, setPhonePin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [deviceName, setDeviceName] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [tokenInvalid, setTokenInvalid] = useState(false);

  const pinTooShort = phonePin.length > 0 && phonePin.length < MIN_PHONE_PIN_LENGTH;
  const pinMismatch = confirmPin.length > 0 && phonePin !== confirmPin;
  const canSubmit =
    masterPassword.trim().length > 0 &&
    phonePin.length >= MIN_PHONE_PIN_LENGTH &&
    phonePin === confirmPin;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!canSubmit || submitting) return;

    setSubmitting(true);
    setError('');

    try {
      const result = await completePairing(apiBase, {
        pairingToken: token,
        masterPassword,
        phonePin,
        deviceName: deviceName.trim() || undefined,
      });

      await saveDeviceAuthLocally({
        deviceId: result.deviceId,
        deviceToken: result.deviceToken,
        wrappedDEKPhonePin: result.wrappedDEKPhonePin,
        wrappedDEKPhonePinIv: result.wrappedDEKPhonePinIv,
        wrappedDEKPhonePinAuthTag: result.wrappedDEKPhonePinAuthTag,
        wrappedDEKPhonePinSalt: result.wrappedDEKPhonePinSalt,
        apiBase,
      });

      setSuccess(true);
    } catch (err) {
      // A 404 means the token itself is dead (never existed, expired, or
      // already used) - no amount of retrying the form fixes that, the
      // owner has to generate a new QR. Anything else (401 wrong
      // password, a validation 400, a network hiccup) stays on the form
      // so the password specifically can be retried without forcing a
      // rescan - only the password field is cleared, the PIN the user
      // already chose is left alone.
      if (err?.response?.status === 404) {
        setTokenInvalid(true);
      } else {
        setError(extractErrorMessage(err, 'Could not pair this device. Try again.'));
        setMasterPassword('');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.brand}>
        <img src={wardenLogo} alt="" className={styles.brandMark} />
        <span className={styles.brandText}>Pair with Warden</span>
      </header>

      <main className={styles.content}>
        {tokenInvalid && (
          <div className={styles.invalidState}>
            <LinkBreak size={40} weight="light" className={styles.invalidIcon} />
            <h1 className={styles.invalidTitle}>This pairing code is no longer valid.</h1>
            <p className={styles.invalidBody}>
              It may have expired or already been used. Ask the vault owner to generate a new code
              and scan it again.
            </p>
          </div>
        )}

        {!tokenInvalid && success && (
          <div className={styles.successState}>
            <CheckCircle size={40} weight="fill" className={styles.successIcon} />
            <h1 className={styles.successTitle}>Paired successfully</h1>
            <p className={styles.successBody}>
              This device can now unlock the vault with its own PIN - you won't need to enter the
              master password here again.
            </p>
          </div>
        )}

        {!tokenInvalid && !success && (
          <div className={styles.formPanel}>
            <div className={styles.copy}>
              <h1 className={styles.title}>Pair this device</h1>
              <p className={styles.subtitle}>
                Enter your Warden master password once to pair this device, and choose a PIN it
                will use to unlock the vault from now on.
              </p>
            </div>

            <form className={styles.form} onSubmit={handleSubmit} noValidate>
              <PasswordField
                label="Warden master password"
                value={masterPassword}
                onChange={(event) => setMasterPassword(event.target.value)}
                placeholder="Enter your master password"
                error={error}
                autoFocus
              />

              <div className={styles.field}>
                <label htmlFor="phone-pin" className={styles.fieldLabel}>
                  Choose a PIN for this device
                </label>
                <input
                  id="phone-pin"
                  type="password"
                  inputMode="numeric"
                  className={styles.textInput}
                  value={phonePin}
                  onChange={(event) => setPhonePin(event.target.value)}
                  placeholder="At least 4 characters"
                  autoComplete="off"
                />
                {pinTooShort && (
                  <p className={styles.fieldError}>
                    PIN must be at least {MIN_PHONE_PIN_LENGTH} characters.
                  </p>
                )}
              </div>

              <div className={styles.field}>
                <label htmlFor="phone-pin-confirm" className={styles.fieldLabel}>
                  Confirm PIN
                </label>
                <input
                  id="phone-pin-confirm"
                  type="password"
                  inputMode="numeric"
                  className={styles.textInput}
                  value={confirmPin}
                  onChange={(event) => setConfirmPin(event.target.value)}
                  placeholder="Re-enter PIN"
                  autoComplete="off"
                />
                {pinMismatch && <p className={styles.fieldError}>PINs don't match.</p>}
              </div>

              <div className={styles.field}>
                <label htmlFor="device-name" className={styles.fieldLabel}>
                  Device name <span className={styles.optional}>(optional)</span>
                </label>
                <input
                  id="device-name"
                  type="text"
                  className={styles.textInput}
                  value={deviceName}
                  onChange={(event) => setDeviceName(event.target.value)}
                  placeholder="e.g. Josh's Phone"
                  autoComplete="off"
                />
              </div>

              <button type="submit" className={styles.submitButton} disabled={!canSubmit || submitting}>
                <span>{submitting ? 'Pairing...' : 'Pair this device'}</span>
                <ArrowRight size={18} weight="bold" />
              </button>
            </form>
          </div>
        )}
      </main>
    </div>
  );
}

export default PairPage;
