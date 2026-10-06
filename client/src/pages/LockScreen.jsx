import { useEffect, useRef, useState } from 'react';
import { ArrowRight } from '@phosphor-icons/react';

import VaultDial from '../components/VaultDial.jsx';
import PasswordField from '../components/PasswordField.jsx';
import RecoveryKeyReveal from '../components/RecoveryKeyReveal.jsx';
import PasswordStrengthMeter from '../components/PasswordStrengthMeter.jsx';
import PhoneRecoveryModal from '../components/PhoneRecoveryModal.jsx';
import wardenLogo from '../assets/warden_logo_badge.svg';
import { signupVault, loginVault, forgotPassword } from '../services/authService.js';
import { extractErrorMessage } from '../services/api.js';
import { validatePassword } from '../utils/passwordPolicy.js';
import styles from './LockScreen.module.css';

const SETTLE_DELAY_MS = 350;
const ERROR_DIAL_RESET_MS = 500;

/**
 * Multi-account now: there is no single implicit vault to detect "has
 * this been set up yet" from, so this is always a Login/Sign up toggle
 * rather than the old setup-vs-unlock branch driven by GET /api/auth/
 * status. `mode` starts on 'login' - the far more common return visit.
 */
function LockScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('login'); // login | signup

  // Login
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  // Forgot password (inline from the login form, like the old recovery
  // choices) - this just sends the email; the actual reset happens on the
  // /reset-password page the emailed link opens.
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotSubmitting, setForgotSubmitting] = useState(false);
  const [forgotMessage, setForgotMessage] = useState('');

  const [phoneRecoveryOpen, setPhoneRecoveryOpen] = useState(false);

  // Signup
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupConfirmPassword, setSignupConfirmPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [confirmError, setConfirmError] = useState('');
  const [signupPhase, setSignupPhase] = useState('form'); // form | reveal | done
  const [pendingRecoveryKey, setPendingRecoveryKey] = useState(null);

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

  const switchToSignup = () => {
    setError('');
    setMode('signup');
  };

  const switchToLogin = () => {
    setError('');
    setForgotOpen(false);
    setForgotMessage('');
    setMode('login');
  };

  const handleLoginSubmit = async (event) => {
    event.preventDefault();
    if (submitting) return;

    if (!loginEmail.trim() || !loginPassword) {
      flashError('Enter your email and password.');
      return;
    }

    setError('');
    setSubmitting(true);
    setDialStatus('unlocking');

    try {
      const { sessionToken } = await loginVault(loginEmail.trim(), loginPassword);
      setDialStatus('unlocked');
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => onAuthenticated(sessionToken), SETTLE_DELAY_MS);
    } catch (err) {
      setSubmitting(false);
      flashError(extractErrorMessage(err, 'Incorrect email or password.'));
    }
  };

  const handleForgotSubmit = async (event) => {
    event.preventDefault();
    if (forgotSubmitting || !forgotEmail.trim()) return;

    setForgotSubmitting(true);
    try {
      const { message } = await forgotPassword(forgotEmail.trim());
      setForgotMessage(message);
    } catch (err) {
      // forgot-password is anti-enumeration by design server-side, so a
      // rejected request here means something genuinely went wrong (bad
      // input, network), not "that email doesn't exist" - still shown
      // plainly rather than silently swallowed.
      setForgotMessage(extractErrorMessage(err, 'Something went wrong. Please try again.'));
    } finally {
      setForgotSubmitting(false);
    }
  };

  const signupPolicy = validatePassword(signupPassword);
  const isSignupFormValid =
    signupEmail.trim().length > 0 &&
    signupPolicy.valid &&
    signupConfirmPassword.length > 0 &&
    signupPassword === signupConfirmPassword;

  const handleSignupSubmit = async (event) => {
    event.preventDefault();
    if (submitting) return;

    setConfirmError('');

    if (!signupPolicy.valid) {
      flashError(signupPolicy.errors.join(' '));
      return;
    }
    if (signupPassword !== signupConfirmPassword) {
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
      const { recoveryKey } = await signupVault(signupEmail.trim(), signupPassword, inviteCode.trim() || undefined);
      setDialStatus('unlocked');
      setPendingRecoveryKey(recoveryKey);
      setSignupPhase('reveal');
    } catch (err) {
      setSubmitting(false);
      flashError(extractErrorMessage(err, 'Could not create an account.'));
    }
  };

  const handleRecoveryKeyConfirm = () => {
    setSignupPhase('done');
    setDialStatus('idle');
    setSubmitting(false);
  };

  const handleBackToLoginAfterSignup = () => {
    setMode('login');
    setSignupPhase('form');
    setLoginEmail(signupEmail);
    setSignupEmail('');
    setSignupPassword('');
    setSignupConfirmPassword('');
    setInviteCode('');
    setPendingRecoveryKey(null);
  };

  // Shared success handler for the phone-recovery modal - same settle
  // delay/dial-unlocked flourish as handleLoginSubmit, just triggered from
  // a modal instead of this component's own form.
  const handlePhoneRecoverySuccess = (sessionToken) => {
    setPhoneRecoveryOpen(false);
    setDialStatus('unlocked');
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => onAuthenticated(sessionToken), SETTLE_DELAY_MS);
  };

  const isSignupReveal = mode === 'signup' && signupPhase === 'reveal' && pendingRecoveryKey;
  const isSignupDone = mode === 'signup' && signupPhase === 'done';
  const isSignupForm = mode === 'signup' && signupPhase === 'form';
  const isLogin = mode === 'login';

  return (
    <main className={styles.screen}>
      <div className={styles.grid} aria-hidden="true" />

      <div className={styles.panel}>
        {!isSignupReveal && (
          <div className={styles.brandRow}>
            <img src={wardenLogo} alt="Warden" className={styles.mark} />
            <span className={styles.wordmark}>WARDEN</span>
          </div>
        )}

        {!isSignupReveal && <VaultDial status={dialStatus} />}

        {isLogin && (
          <>
            <div className={styles.copy}>
              <h1 className={styles.title}>Welcome back.</h1>
              <p className={styles.subtitle}>Log in to decrypt and open your vault.</p>
            </div>

            <form className={styles.form} onSubmit={handleLoginSubmit} noValidate>
              <div className={styles.field}>
                <label htmlFor="login-email" className={styles.fieldLabel}>
                  Email
                </label>
                <input
                  id="login-email"
                  type="email"
                  className={styles.textInput}
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  autoFocus
                />
              </div>

              <PasswordField
                label="Password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                placeholder="Enter your password"
                error={error}
              />

              <button type="submit" className={styles.primaryButton} disabled={submitting}>
                <span>{submitting ? 'Logging in' : 'Log in'}</span>
                <ArrowRight size={18} weight="bold" />
              </button>

              <button
                type="button"
                className={styles.linkButton}
                onClick={() => {
                  setForgotOpen((open) => !open);
                  setForgotMessage('');
                  setForgotEmail(loginEmail);
                }}
                aria-expanded={forgotOpen}
              >
                Forgot your password?
              </button>

              {forgotOpen && (
                <div className={styles.recoveryChoices}>
                  {forgotMessage ? (
                    <p className={styles.subtitle}>{forgotMessage}</p>
                  ) : (
                    <form className={styles.form} onSubmit={handleForgotSubmit} noValidate>
                      <div className={styles.field}>
                        <label htmlFor="forgot-email" className={styles.fieldLabel}>
                          Account email
                        </label>
                        <input
                          id="forgot-email"
                          type="email"
                          className={styles.textInput}
                          value={forgotEmail}
                          onChange={(e) => setForgotEmail(e.target.value)}
                          placeholder="you@example.com"
                          autoComplete="email"
                        />
                      </div>
                      <button
                        type="submit"
                        className={styles.primaryButton}
                        disabled={forgotSubmitting || !forgotEmail.trim()}
                      >
                        {forgotSubmitting ? 'Sending...' : 'Email me a reset link'}
                      </button>
                    </form>
                  )}
                  <button
                    type="button"
                    className={styles.recoveryChoice}
                    onClick={() => setPhoneRecoveryOpen(true)}
                  >
                    Recover with paired phone instead
                  </button>
                </div>
              )}

              <button type="button" className={styles.linkButton} onClick={switchToSignup}>
                Don't have an account? Create one
              </button>
            </form>
          </>
        )}

        {isSignupForm && (
          <>
            <div className={styles.copy}>
              <h1 className={styles.title}>Create your account</h1>
              <p className={styles.subtitle}>
                Your master password encrypts everything in your vault. It can't be recovered if
                lost, only the recovery key shown next.
              </p>
            </div>

            <form className={styles.form} onSubmit={handleSignupSubmit} noValidate>
              <div className={styles.field}>
                <label htmlFor="signup-email" className={styles.fieldLabel}>
                  Email
                </label>
                <input
                  id="signup-email"
                  type="email"
                  className={styles.textInput}
                  value={signupEmail}
                  onChange={(e) => setSignupEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  autoFocus
                />
              </div>

              <PasswordField
                label="Master password"
                value={signupPassword}
                onChange={(e) => setSignupPassword(e.target.value)}
                placeholder="Enter a strong password"
                error={error}
              />

              <PasswordStrengthMeter password={signupPassword} />

              <PasswordField
                label="Confirm password"
                value={signupConfirmPassword}
                onChange={(e) => setSignupConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
                error={confirmError}
              />

              <div className={styles.field}>
                <label htmlFor="signup-invite" className={styles.fieldLabel}>
                  Invite code (if you have one)
                </label>
                <input
                  id="signup-invite"
                  type="text"
                  className={styles.textInput}
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="Leave blank if not required"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              <button
                type="submit"
                className={styles.primaryButton}
                disabled={submitting || !isSignupFormValid}
              >
                <span>{submitting ? 'Creating account' : 'Create account'}</span>
                <ArrowRight size={18} weight="bold" />
              </button>

              <button type="button" className={styles.linkButton} onClick={switchToLogin}>
                Already have an account? Log in
              </button>
            </form>
          </>
        )}

        {isSignupReveal && (
          <RecoveryKeyReveal
            recoveryKey={pendingRecoveryKey}
            onConfirm={handleRecoveryKeyConfirm}
            subtitle="If you're setting up for the first time, this is the only way to recover your vault if you forget your master password. Save it now - it's shown once, right now, and never again."
          />
        )}

        {isSignupDone && (
          <div className={styles.copy}>
            <h1 className={styles.title}>Check your email</h1>
            <p className={styles.subtitle}>
              If that email can be registered, a verification link was just sent to it. Open it to
              finish setting up your account, then come back and log in.
            </p>
            <button type="button" className={styles.primaryButton} onClick={handleBackToLoginAfterSignup}>
              <span>Back to log in</span>
              <ArrowRight size={18} weight="bold" />
            </button>
          </div>
        )}
      </div>

      {phoneRecoveryOpen && (
        <PhoneRecoveryModal
          onClose={() => setPhoneRecoveryOpen(false)}
          onRecovered={handlePhoneRecoverySuccess}
          initialEmail={forgotEmail || loginEmail}
        />
      )}
    </main>
  );
}

export default LockScreen;
