import { useEffect, useRef, useState } from 'react';
import { ArrowRight } from '@phosphor-icons/react';

import VaultDial from '../components/VaultDial.jsx';
import PasswordField from '../components/PasswordField.jsx';
import RecoveryKeyReveal from '../components/RecoveryKeyReveal.jsx';
import PasswordStrengthMeter from '../components/PasswordStrengthMeter.jsx';
import wardenLogo from '../assets/wardenpurple_logo.png';
import { setupVault, unlockVault, recoverVault } from '../services/authService.js';
import { extractErrorMessage } from '../services/api.js';
import { validatePassword } from '../utils/passwordPolicy.js';
import styles from './LockScreen.module.css';

const SETTLE_DELAY_MS = 350;
const ERROR_DIAL_RESET_MS = 500;

function LockScreen({ statusLoading, initialized, onAuthenticated }) {
  // Unlock flow
  const [passphrase, setPassphrase] = useState('');
  const [unlockMode, setUnlockMode] = useState('unlock'); // 'unlock' | 'recover'

  // Forgot-password / recovery flow
  const [recoveryKeyInput, setRecoveryKeyInput] = useState('');
  const [newPassword, setNewPassword] = useState('');

  // First-run setup flow
  const [setupPhase, setSetupPhase] = useState('form'); // 'form' | 'reveal'
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

  const switchToRecover = () => {
    setError('');
    setPassphrase('');
    setUnlockMode('recover');
  };

  const switchToUnlock = () => {
    setError('');
    setRecoveryKeyInput('');
    setNewPassword('');
    setUnlockMode('unlock');
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

  const recoverPolicy = validatePassword(newPassword);
  const isRecoverFormValid = recoveryKeyInput.trim().length > 0 && recoverPolicy.valid;

  const handleRecoverSubmit = async (event) => {
    event.preventDefault();
    if (submitting) return;

    if (!recoveryKeyInput.trim()) {
      flashError('Enter your recovery key.');
      return;
    }

    if (!recoverPolicy.valid) {
      flashError(recoverPolicy.errors.join(' '));
      return;
    }

    setError('');
    setSubmitting(true);
    setDialStatus('unlocking');

    try {
      const { sessionToken } = await recoverVault(recoveryKeyInput.trim(), newPassword);
      setDialStatus('unlocked');
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => onAuthenticated(sessionToken), SETTLE_DELAY_MS);
    } catch (err) {
      setSubmitting(false);
      flashError(extractErrorMessage(err, 'Recovery failed.'));
    }
  };

  const setupPolicy = validatePassword(password);
  const isSetupFormValid =
    setupPolicy.valid && confirmPassword.length > 0 && password === confirmPassword;

  const handleSetupSubmit = async (event) => {
    event.preventDefault();
    if (submitting) return;

    setConfirmError('');

    if (!setupPolicy.valid) {
      flashError(setupPolicy.errors.join(' '));
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
      setSetupPhase('reveal');
    } catch (err) {
      setSubmitting(false);
      flashError(extractErrorMessage(err, 'Could not set up the vault.'));
    }
  };

  const handleRecoveryConfirm = () => {
    if (pendingSession) onAuthenticated(pendingSession.sessionToken);
  };

  const isChecking = statusLoading;
  const isSetupReveal = !isChecking && !initialized && setupPhase === 'reveal' && pendingSession;
  const isSetupForm = !isChecking && !initialized && setupPhase === 'form';
  const isUnlock = !isChecking && initialized && unlockMode === 'unlock';
  const isRecover = !isChecking && initialized && unlockMode === 'recover';

  return (
    <main className={styles.screen}>
      <div className={styles.grid} aria-hidden="true" />

      <div className={styles.panel}>
        {!isSetupReveal && (
          <div className={styles.brandRow}>
            <img src={wardenLogo} alt="Warden" className={styles.mark} />
            <span className={styles.wordmark}>WARDEN</span>
          </div>
        )}

        {!isSetupReveal && <VaultDial status={dialStatus} />}

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

              <PasswordStrengthMeter password={password} />

              <PasswordField
                label="Confirm password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
                error={confirmError}
              />

              <button
                type="submit"
                className={styles.primaryButton}
                disabled={submitting || !isSetupFormValid}
              >
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

              <button type="button" className={styles.linkButton} onClick={switchToRecover}>
                Forgot your password? Use your recovery key
              </button>
            </form>
          </>
        )}

        {isRecover && (
          <>
            <div className={styles.copy}>
              <h1 className={styles.title}>Reset your password</h1>
              <p className={styles.subtitle}>
                Enter your recovery key and choose a new master password. Your
                documents stay exactly as they are.
              </p>
            </div>

            <form className={styles.form} onSubmit={handleRecoverSubmit} noValidate>
              <div className={styles.field}>
                <label htmlFor="recovery-key-input" className={styles.fieldLabel}>
                  Recovery key
                </label>
                <input
                  id="recovery-key-input"
                  type="text"
                  className={styles.textInput}
                  value={recoveryKeyInput}
                  onChange={(e) => setRecoveryKeyInput(e.target.value)}
                  placeholder="XXXX-XXXX-XXXX-XXXX"
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              <PasswordField
                label="New master password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter a new strong password"
                error={error}
              />

              <PasswordStrengthMeter password={newPassword} />

              <button
                type="submit"
                className={styles.primaryButton}
                disabled={submitting || !isRecoverFormValid}
              >
                <span>{submitting ? 'Resetting password' : 'Reset password'}</span>
                <ArrowRight size={18} weight="bold" />
              </button>

              <button type="button" className={styles.linkButton} onClick={switchToUnlock}>
                Back to unlock
              </button>
            </form>
          </>
        )}

        {isSetupReveal && (
          <RecoveryKeyReveal
            recoveryKey={pendingSession.recoveryKey}
            onConfirm={handleRecoveryConfirm}
          />
        )}

        {!isSetupReveal && (
          <p className={styles.trustNote}>AES-256 encryption · Local instance, no cloud sync</p>
        )}
      </div>
    </main>
  );
}

export default LockScreen;
