import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, CheckCircle, Warning } from '@phosphor-icons/react';

import wardenLogo from '../assets/warden_logo_badge.svg';
import PasswordField from '../components/PasswordField.jsx';
import PasswordStrengthMeter from '../components/PasswordStrengthMeter.jsx';
import { resetPassword } from '../services/authService.js';
import { extractErrorMessage } from '../services/api.js';
import { validatePassword } from '../utils/passwordPolicy.js';
import styles from './PairPage.module.css';

/**
 * /reset-password?token=... - the link POST /api/auth/forgot-password
 * emails out. Lives entirely outside the login/signup flow - the token in
 * the URL proves email ownership only; it never unwraps anything on its
 * own (see the server's own comment on this for why recoveryKey matters).
 *
 * Two very different outcomes depending on whether a recovery key is
 * given: with it, every existing document stays decryptable; without it,
 * confirmWipe has to be checked, and the response hands back a brand-new
 * recovery key once (the old one no longer means anything - see
 * services/authService.js resetPassword).
 */
function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  const policy = validatePassword(newPassword);
  const hasRecoveryKey = recoveryKey.trim().length > 0;
  const canSubmit =
    Boolean(token) &&
    policy.valid &&
    confirmPassword.length > 0 &&
    newPassword === confirmPassword &&
    (hasRecoveryKey || confirmWipe);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!canSubmit || submitting) return;

    setConfirmError('');
    if (newPassword !== confirmPassword) {
      setConfirmError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const data = await resetPassword({
        token,
        newPassword,
        recoveryKey: hasRecoveryKey ? recoveryKey.trim() : undefined,
        confirmWipe: hasRecoveryKey ? undefined : confirmWipe,
      });
      setResult(data);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not reset your password. The link may have expired.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.brand}>
        <img src={wardenLogo} alt="" className={styles.brandMark} />
        <span className={styles.brandText}>Warden</span>
      </header>

      <main className={styles.content}>
        {!token && (
          <div className={styles.invalidState}>
            <h1 className={styles.invalidTitle}>This link is missing its token.</h1>
            <p className={styles.invalidBody}>
              Request a new password reset link from the log in screen.
            </p>
            <Link to="/" className={styles.submitButton}>
              Back to log in
            </Link>
          </div>
        )}

        {token && result && (
          <div className={styles.successState}>
            <CheckCircle size={40} weight="fill" className={styles.successIcon} />
            <h1 className={styles.successTitle}>Password reset</h1>
            <p className={styles.successBody}>
              {result.documentsWiped
                ? 'Your password was reset. Since no recovery key was provided, this created a brand-new, empty vault - your previous documents are gone.'
                : 'Your password was reset and your existing documents are still there.'}
            </p>

            {result.recoveryKey && (
              <div className={styles.formPanel} style={{ width: '100%' }}>
                <Warning size={20} weight="fill" />
                <p className={styles.subtitle}>
                  Save this new recovery key now - it won't be shown again:
                </p>
                <code style={{ wordBreak: 'break-all', fontFamily: 'var(--font-mono)' }}>
                  {result.recoveryKey}
                </code>
              </div>
            )}

            <Link to="/" className={styles.submitButton}>
              Go to log in
            </Link>
          </div>
        )}

        {token && !result && (
          <div className={styles.formPanel}>
            <div className={styles.copy}>
              <h1 className={styles.title}>Reset your password</h1>
              <p className={styles.subtitle}>
                Enter your recovery key to keep your existing documents, or skip it to start a
                brand-new, empty vault.
              </p>
            </div>

            <form className={styles.form} onSubmit={handleSubmit} noValidate>
              <div className={styles.field}>
                <label htmlFor="reset-recovery-key" className={styles.fieldLabel}>
                  Recovery key <span className={styles.optional}>(optional)</span>
                </label>
                <input
                  id="reset-recovery-key"
                  type="text"
                  className={styles.textInput}
                  value={recoveryKey}
                  onChange={(e) => setRecoveryKey(e.target.value)}
                  placeholder="XXXX-XXXX-XXXX-XXXX"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              <PasswordField
                label="New password"
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

              {!hasRecoveryKey && (
                <div className={styles.field}>
                  <label htmlFor="confirm-wipe" style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-start' }}>
                    <input
                      id="confirm-wipe"
                      type="checkbox"
                      checked={confirmWipe}
                      onChange={(e) => setConfirmWipe(e.target.checked)}
                    />
                    <span className={styles.fieldError} style={{ color: 'var(--color-text-muted)' }}>
                      I understand that without my recovery key, resetting my password will
                      permanently delete all of my existing documents and start a brand-new, empty
                      vault.
                    </span>
                  </label>
                </div>
              )}

              <button type="submit" className={styles.submitButton} disabled={!canSubmit || submitting}>
                <span>{submitting ? 'Resetting...' : 'Reset password'}</span>
                <ArrowRight size={18} weight="bold" />
              </button>
            </form>
          </div>
        )}
      </main>
    </div>
  );
}

export default ResetPasswordPage;
