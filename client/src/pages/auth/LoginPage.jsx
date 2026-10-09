import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';

import Icon from '../../components/site/Icon.jsx';
import SensitiveInput from '../../components/SensitiveInput.jsx';
import OtpChallengePanel from '../../components/OtpChallengePanel.jsx';
import { loginVault, resendOtp, verifyOtp } from '../../services/authService.js';
import { extractErrorMessage } from '../../services/api.js';
import { adoptTokenFromOtherTabs, setToken, takeSessionNotice } from '../../services/session.js';
import { formatClock } from '../../utils/otpInput.js';
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
  return safeRedirectPath(path, '/files');
}

/**
 * Login is two steps. Step 1 verifies the email and password; the server
 * then emails a 6-digit code and answers with a challenge instead of a
 * session. Step 2 is the code (components/OtpChallengePanel.jsx). The
 * challenge lives ONLY in this component's state - never in storage, the URL
 * or router state - and is dropped on Back, on success, and on expiry.
 */
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
  const [challenge, setChallenge] = useState(null); // step 2 when set
  const settleTimer = useRef(null);
  // "Your session expired. Sign in again." - shown once, when the server ended the session we were holding.
  const [sessionNotice] = useState(() => takeSessionNotice());
  // A second tab of a signed-in browser: pick the session up from the other tab instead of asking again.
  useEffect(() => {
    adoptTokenFromOtherTabs();
  }, []);

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
  if (token && !submitting && !challenge) return <Navigate to={returnPathFrom(location)} replace />;

  const locked = problem?.kind === 'locked' && secondsLeft > 0;

  const leaveCodeStep = (nextProblem = null) => {
    setChallenge(null);
    setDial('idle');
    setProblem(nextProblem);
  };

  const finishLogin = (sessionToken) => {
    // Success: the challenge is spent, so drop it before moving on.
    setChallenge(null);
    setDial('unlocked');
    settleTimer.current = setTimeout(() => {
      setToken(sessionToken);
      navigate(returnPathFrom(location), { replace: true });
    }, SETTLE_DELAY_MS);
  };

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
      const result = await loginVault(email.trim(), password);
      setPassword('');
      if (result.otpRequired) {
        // Step 2: a code has been emailed. No session exists yet.
        setChallenge(result);
        setSubmitting(false);
        setDial('idle');
        return;
      }
      finishLogin(result.sessionToken);
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
        setProblem({ kind: 'other', message: 'Too many attempts. Please wait a few minutes and try again.' });
      } else {
        setProblem({ kind: 'other', message: extractErrorMessage(err, 'We couldn’t log you in. Please try again.') });
      }
      setPassword('');
    }
  };

  // ---- Step 2: the emailed code ----
  if (challenge) {
    return (
      <AuthLayout
        title="Check your email"
        subtitle={`We sent a 6-digit code to ${email.trim()}. Enter it to finish logging in.`}
        dial={dial}
      >
        <OtpChallengePanel
          challenge={challenge}
          onSubmitCode={(code, challengeToken, trust) => verifyOtp(challengeToken, code, trust)}
          trustOption
          onResend={resendOtp}
          onVerified={({ sessionToken }) => finishLogin(sessionToken)}
          onBack={() => leaveCodeStep()}
          onDead={(message) => leaveCodeStep({ kind: 'other', message })}
          onStatus={setDial}
          submitLabel="Verify and log in"
        />
      </AuthLayout>
    );
  }

  // ---- Step 1: email and password ----
  return (
    <AuthLayout
      title="Log in to your vault"
      subtitle="Enter your email and password. We’ll then email you a 6-digit code to finish logging in."
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
        {sessionNotice && !location.state?.passwordReset && (
          <div className={forms.notice} role="status">
            <Icon name="lock" />
            <p>{sessionNotice}</p>
          </div>
        )}
        {location.state?.passwordReset && (
          <div className={forms.notice} role="status">
            <Icon name="check" />
            <p>
              <strong>Your password was changed.</strong>{' '}
              {location.state.passwordReset === 'wiped'
                ? 'Your vault was erased and replaced with a new, empty one. '
                : 'Your documents were kept. '}
              Everyone was signed out. Log in with your new password; we’ll email you a code as usual.
            </p>
          </div>
        )}
        <div role="alert" aria-live="assertive">
          {problem?.kind === 'locked' && locked && (
            <div className={forms.alert}>
              <Icon name="lock" />
              <p>
                Too many failed attempts. This account is locked for{' '}
                <strong>{formatClock(secondsLeft)}</strong>. You can try again after that.
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
          <SensitiveInput
            fieldName="login-contact"
            id="login-email"
            type="email"
            className={forms.input}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            inputMode="email"
            autoFocus
          />
        </div>

        <PasswordInput
          id="login-password"
          label="Password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="off"
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
          {submitting ? 'Checking…' : locked ? `Locked for ${formatClock(secondsLeft)}` : 'Continue'}
        </button>
      </form>
    </AuthLayout>
  );
}

export default LoginPage;
