import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';

import Icon from '../../components/site/Icon.jsx';
import { loginVault } from '../../services/authService.js';
import { extractErrorMessage } from '../../services/api.js';
import { setToken } from '../../services/session.js';
import { safeRedirectPath } from '../../utils/safeRedirect.js';
import { useSessionToken } from '../../utils/useSessionToken.js';
import { usePageMeta } from '../../utils/usePageMeta.js';
import AuthLayout from './AuthLayout.jsx';
import PasswordInput from './PasswordInput.jsx';
import ResendButton from './ResendButton.jsx';
import site from '../../components/site/site.module.css';
import forms from '../../components/site/forms.module.css';
import styles from './auth.module.css';

const SETTLE_DELAY_MS = 350; // lets the vault dial finish its "unlocked" turn

/**
 * Where to go after logging in: back to the page the person was on, if
 * there is one, otherwise the vault. The remembered path is router state,
 * so it goes through safeRedirectPath (utils/safeRedirect.js) - a missing,
 * malformed or hostile value (`//evil.com`, `/\evil.com`, encoded variants)
 * is ignored and the normal destination is used instead.
 */
export function returnPathFrom(location) {
  const from = location.state?.from;
  const path = from ? `${from.pathname || ''}${from.search || ''}` : '';
  return safeRedirectPath(path, '/vault');
}

function formatCountdown(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function LoginPage() {
  usePageMeta('Log in', 'Log in to your Warden vault.');
  const navigate = useNavigate();
  const location = useLocation();
  const token = useSessionToken();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [dial, setDial] = useState('idle');
  // { kind: 'generic' | 'locked' | 'unverified' | 'other', message, lockedUntil? }
  const [problem, setProblem] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const settleTimer = useRef(null);

  useEffect(() => () => clearTimeout(settleTimer.current), []);

  // Lockout countdown, driven by the server's own lockedUntil.
  useEffect(() => {
    if (problem?.kind !== 'locked') return undefined;
    const until = new Date(problem.lockedUntil).getTime();
    const tick = () => {
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) setProblem(null);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [problem]);

  // Already signed in (e.g. pressed Back after logging in): straight on.
  if (token && !submitting) return <Navigate to={returnPathFrom(location)} replace />;

  const locked = problem?.kind === 'locked' && secondsLeft > 0;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (submitting || locked) return;
    if (!email.trim() || !password) {
      setProblem({ kind: 'other', message: 'Enter your email and password.' });
      return;
    }

    setSubmitting(true);
    setProblem(null);
    setDial('unlocking');
    try {
      const { sessionToken } = await loginVault(email.trim(), password);
      // --- Future email OTP step: if the server starts answering with an
      // "otpRequired" response instead of a sessionToken, render the code
      // entry step here and only call setToken() once it succeeds. ---
      setDial('unlocked');
      settleTimer.current = setTimeout(() => {
        setToken(sessionToken);
        navigate(returnPathFrom(location), { replace: true });
      }, SETTLE_DELAY_MS);
    } catch (err) {
      setSubmitting(false);
      setDial('error');
      setTimeout(() => setDial('idle'), 600);
      const body = err?.response?.data?.error;
      if (body?.locked) {
        setProblem({ kind: 'locked', lockedUntil: body.lockedUntil });
      } else if (body?.emailVerificationRequired) {
        setProblem({ kind: 'unverified', message: body.message });
      } else if (err?.response?.status === 401) {
        setProblem({ kind: 'generic', message: 'That email and password don’t match an account.' });
      } else if (err?.response?.status === 429) {
        setProblem({ kind: 'other', message: 'Too many attempts from this connection. Please wait a few minutes.' });
      } else {
        setProblem({ kind: 'other', message: extractErrorMessage(err, 'We couldn’t log you in. Please try again.') });
      }
      setPassword('');
    }
  };

  return (
    <AuthLayout
      title="Log in to your vault"
      subtitle="Your password unlocks your vault key for this session only."
      dial={dial}
      footer={
        <>
          <span>
            New to Warden?{' '}
            <Link to="/signup" className={site.textLink}>
              Create a vault
            </Link>
          </span>
        </>
      }
    >
      <form className={forms.form} onSubmit={handleSubmit} noValidate>
        <div role="alert" aria-live="assertive">
          {problem?.kind === 'locked' && locked && (
            <div className={forms.alert}>
              <Icon name="lock" />
              <p>
                Too many failed attempts. This account is locked for{' '}
                <strong>{formatCountdown(secondsLeft)}</strong>. You can try again after that.
              </p>
            </div>
          )}
          {(problem?.kind === 'generic' || problem?.kind === 'other') && (
            <div className={forms.alert}>
              <Icon name="alert" />
              <p>{problem.message}</p>
            </div>
          )}
          {problem?.kind === 'unverified' && (
            <div className={forms.notice}>
              <Icon name="mail" />
              <div className={styles.stack} style={{ gap: 12 }}>
                <p>
                  Your password is right, but this email isn&apos;t verified yet. Open the link we emailed you, or
                  get a new one. Check your spam folder too.
                </p>
                <ResendButton email={email.trim()} />
              </div>
            </div>
          )}
        </div>

        <div className={forms.field}>
          <label htmlFor="login-email" className={forms.label}>
            Email
          </label>
          <input
            id="login-email"
            type="email"
            className={forms.input}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            inputMode="email"
            autoFocus
          />
        </div>

        <PasswordInput
          id="login-password"
          label="Password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
        />

        <div className={styles.inlineLinkRow}>
          <Link to="/forgot-password" className={styles.inlineLink}>
            Forgot password?
          </Link>
        </div>

        <button
          type="submit"
          className={`${site.button} ${site.primary} ${site.block}`}
          disabled={submitting || locked}
        >
          {submitting ? 'Unlocking…' : locked ? `Locked for ${formatCountdown(secondsLeft)}` : 'Log in'}
        </button>
      </form>
    </AuthLayout>
  );
}

export default LoginPage;
