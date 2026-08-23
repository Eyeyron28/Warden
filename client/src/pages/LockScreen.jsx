import { useEffect, useRef, useState } from 'react';
import { ArrowRight } from '@phosphor-icons/react';

import VaultDial from '../components/VaultDial.jsx';
import PasswordField from '../components/PasswordField.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import RecoveryKeyReveal from '../components/RecoveryKeyReveal.jsx';
import { setupVault, unlockVault } from '../services/authService.js';
import { extractErrorMessage } from '../services/api.js';
import styles from './LockScreen.module.css';

const SETTLE_DELAY_MS = 350;
const ERROR_DIAL_RESET_MS = 500;
const MIN_PASSWORD_LENGTH = 8;

function LockScreen({ statusLoading, initialized, onAuthenticated }) {
  // Unlock flow
  const [passphrase, setPassphrase] = useState('');

  // First-run setup flow
  const [setupPhase, setSetupPhase] = useState('form'); // 'form' | 'recovery'
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [confirmError, setConfirmError] = useState('');
  const [pendingSession, setPendingSession] = useState(null); // { sessionToken, recoveryKey }

  const [dialStatus, setDialStatus] = useState('idle'); // idle | unlocking | unlocked | error
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const timeoutRef = useRef(null);

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  const flashError = (message) => {
    clearTimeout(timeoutRef.current);
    setError(message);
    setDialStatus('error');
    timeoutRef.current = setTimeout(() => setDialStatus('idle'), ERROR_DIAL_RESET_MS);
  };

  const handleUnlockSubmit = async (event) => {
    event.preventDefault();
    if (submitting) return;

    if (!passphrase.trim()) {
      flashError('Enter your vault passphrase.');
      return;
    }

    setError('');
    setSubmitting(true);
    setDialStatus('unlocking');

    try {
      const { sessionToken } = await unlockVault(passphrase);
      setDialStatus('unlocked');
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => onAuthenticated(sessionToken), SETTLE_DELAY_MS);
    } catch (err) {
      setSubmitting(false);
      flashError(extractErrorMessage(err, 'Incorrect passphrase.'));
    }
  };

  const handleSetupSubmit = async (event) => {
    event.preventDefault();
    if (submitting) return;

    setConfirmError('');

    if (password.length < MIN_PASSWORD_LENGTH) {
      flashError(`Master password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    if (password !== confirmPassword) {
      clearTimeout(timeoutRef.current);
      setConfirmError('Passwords do not match.');
      setDialStatus('error');
      timeoutRef.current = setTimeout(() => setDialStatus('idle'), ERROR_DIAL_RESET_MS);
      return;
    }

    setError('');
    setSubmitting(true);
    setDialStatus('unlocking');

    try {
      const { sessionToken, recoveryKey } = await setupVault(password);
      setDialStatus('unlocked');
      setPendingSession({ sessionToken, recoveryKey });
      setSetupPhase('recovery');
    } catch (err) {
      setSubmitting(false);
      flashError(extractErrorMessage(err, 'Could not set up the vault.'));
    }
  };

  const handleRecoveryConfirm = () => {
    if (pendingSession) onAuthenticated(pendingSession.sessionToken);
  };

  const isChecking = statusLoading;
  const isSetupRecovery = !isChecking && !initialized && setupPhase === 'recovery' && pendingSession;
  const isSetupForm = !isChecking && !initialized && setupPhase === 'form';
  const isUnlock = !isChecking && initialized;

  return (
    <main className={styles.screen}>
      <div className={styles.grid} aria-hidden="true" />

      <div className={styles.panel}>
        {!isSetupRecovery && (
          <div className={styles.brandRow}>
            <span className={styles.mark}>W</span>
            <span className={styles.wordmark}>WARDEN</span>
          </div>
        )}

        {!isSetupRecovery && <VaultDial status={dialStatus} />}

        {isChecking && (
          <div className={styles.copy}>
            <h1 className={styles.title}>Checking vault status...</h1>
          </div>
        )}

        {isSetupForm && (
          <>
            <div className={styles.copy}>
              <h1 className={styles.title}>Create your master password</h1>
              <p className={styles.subtitle}>
                This password encrypts everything in your vault. It can't be
                recovered if lost, only the recovery key shown next.
              </p>
            </div>

            <form className={styles.form} onSubmit={handleSetupSubmit} noValidate>
              <PasswordField
                label="Master password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter a strong password"
                error={error}
                autoFocus
              />
              <PasswordField
                label="Confirm password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
                error={confirmError}
              />

              <button type="submit" className={styles.primaryButton} disabled={submitting}>
                <span>{submitting ? 'Creating vault' : 'Create vault'}</span>
                <ArrowRight size={18} weight="bold" />
              </button>
            </form>
          </>
        )}

        {isUnlock && (
          <>
            <div className={styles.copy}>
              <h1 className={styles.title}>Your vault is sealed.</h1>
              <p className={styles.subtitle}>
                Enter your passphrase to decrypt and open this local vault.
              </p>
            </div>

            <form className={styles.form} onSubmit={handleUnlockSubmit} noValidate>
              <PasswordField
                label="Vault passphrase"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Enter passphrase"
                error={error}
                autoFocus
              />

              <button type="submit" className={styles.primaryButton} disabled={submitting}>
                <span>{submitting ? 'Unlocking' : 'Unlock vault'}</span>
                <ArrowRight size={18} weight="bold" />
              </button>
            </form>
          </>
        )}

        {isSetupRecovery && (
          <RecoveryKeyReveal
            recoveryKey={pendingSession.recoveryKey}
            onConfirm={handleRecoveryConfirm}
          />
        )}

        {!isSetupRecovery && (
          <div className={styles.footerBadges}>
            <StatusBadge label="AES-256" />
            <StatusBadge label="Local instance, no cloud sync" />
          </div>
        )}
      </div>
    </main>
  );
}

export default LockScreen;
