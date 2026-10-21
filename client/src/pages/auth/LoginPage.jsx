import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';

import Icon from '../../components/site/Icon.jsx';
import SensitiveInput from '../../components/SensitiveInput.jsx';
import OtpChallengePanel from '../../components/OtpChallengePanel.jsx';
import { loginVault, resendOtp, verifyOtp } from '../../services/authService.js';
import { extractErrorMessage } from '../../services/api.js';
import { adoptTokenFromOtherTabs, setToken, takeSessionNotice } from '../../services/session.js';
import { formatClock } from '../../utils/otpInput.js';
import { getEmergencyMode, leaveEmergencyMode, subscribeEmergencyMode } from '../../services/emergencyMode.js';
import { visitMemory } from '../../services/visitMemory.js';
import { useSessionToken } from '../../utils/useSessionToken.js';
import { usePageMeta } from '../../utils/usePageMeta.js';
import AuthLayout from './AuthLayout.jsx';
import PasswordInput from './PasswordInput.jsx';
import ResendButton from './ResendButton.jsx';
import site from '../../components/site/site.module.css';
import forms from '../../components/site/forms.module.css';
import styles from './auth.module.css';

const SETTLE_DELAY_MS = 350;

export function landingFor(email) {
  return visitMemory.landingAfterLogin(email);
}

function LoginPage() {
  usePageMeta('Log in', 'Log in to your Warden vault.');
  const navigate = useNavigate();
  const location = useLocation();
  const token = useSessionToken();
  const emergency = useSyncExternalStore(subscribeEmergencyMode, getEmergencyMode);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [dial, setDial] = useState('idle');
  const [problem, setProblem] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [challenge, setChallenge] = useState(null);
  const settleTimer = useRef(null);
  const [sessionNotice] = useState(() => takeSessionNotice());
  useEffect(() => {
    adoptTokenFromOtherTabs();
  }, []);

  useEffect(() => () => clearTimeout(settleTimer.current), []);

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

  if (token && !emergency.emergency && !submitting && !challenge) return <Navigate to="/files" replace />;

  const locked = problem?.kind === 'locked' && secondsLeft > 0;

  const leaveCodeStep = (nextProblem = null) => {
    setChallenge(null);
    setDial('idle');
    setProblem(nextProblem);
  };

  const finishLogin = (sessionToken) => {
    setChallenge(null);
    setDial('unlocked');
    settleTimer.current = setTimeout(() => {
      const landing = landingFor(email.trim());
      leaveEmergencyMode();
      setToken(sessionToken);
      visitMemory.rememberAccount(email.trim());
      navigate(landing, { replace: true });
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
        <p className={forms.hint}>* Required</p>
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
          <label data-required htmlFor="login-email" className={forms.label}>
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
