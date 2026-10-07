import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';

import Icon from '../../components/site/Icon.jsx';
import OtpCodeInput from '../../components/OtpCodeInput.jsx';
import { loginVault, resendOtp, verifyOtp } from '../../services/authService.js';
import { extractErrorMessage } from '../../services/api.js';
import { setToken } from '../../services/session.js';
import { emptyDigits, formatClock, isComplete, toCode } from '../../utils/otpInput.js';
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

const OTP_FAILED = 'That code is incorrect or has expired. Check it and try again, or go back and log in again.';

/** A server challenge, turned into millisecond timestamps for the countdowns. */
function readChallenge(data) {
  return {
    token: data.challengeToken,
    expiresAt: new Date(data.expiresAt).getTime(),
    resendAvailableAt: new Date(data.resendAvailableAt).getTime(),
    resendsLeft: data.resendsLeft,
  };
}

/**
 * Login is two steps. Step 1 verifies the email and password; the server
 * then emails a 6-digit code and answers with a challenge instead of a
 * session. Step 2 is the code. The challenge token lives ONLY in this
 * component's state - never in storage, the URL or router state - and is
 * dropped on Back, on success, and when the code expires.
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
  const settleTimer = useRef(null);

  // Step 2 (the emailed code). `challenge` is null during step 1.
  const [challenge, setChallenge] = useState(null);
  const [digits, setDigits] = useState(emptyDigits);
  const [codeMessage, setCodeMessage] = useState(null); // { tone: 'error' | 'info', text }
  const [resending, setResending] = useState(false);
  const [now, setNow] = useState(Date.now());

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

  // One clock for the code step's two countdowns (expiry and resend).
  const hasChallenge = Boolean(challenge);
  useEffect(() => {
    if (!hasChallenge) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasChallenge]);

  const expiresInSeconds = challenge ? Math.max(0, Math.ceil((challenge.expiresAt - now) / 1000)) : 0;
  const resendInSeconds = challenge ? Math.max(0, Math.ceil((challenge.resendAvailableAt - now) / 1000)) : 0;

  // The code ran out: the server has dropped the challenge, so drop the
  // token here too and send the person back to step 1.
  useEffect(() => {
    if (challenge && expiresInSeconds === 0 && !submitting) {
      setChallenge(null);
      setDigits(emptyDigits());
      setCodeMessage(null);
      setDial('idle');
      setProblem({ kind: 'other', message: 'That code expired. Log in again to get a new one.' });
    }
  }, [challenge, expiresInSeconds, submitting]);

  // The sixth digit submits, so a pasted or autofilled code is one step. A
  // failed or resent code clears the boxes, so this cannot loop.
  useEffect(() => {
    if (challenge && !submitting && isComplete(digits)) handleVerify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digits]);

  // Already signed in (e.g. pressed Back after logging in): straight on.
  if (token && !submitting) return <Navigate to={returnPathFrom(location)} replace />;

  const locked = problem?.kind === 'locked' && secondsLeft > 0;

  const leaveCodeStep = (nextProblem = null) => {
    setChallenge(null);
    setDigits(emptyDigits());
    setCodeMessage(null);
    setDial('idle');
    setProblem(nextProblem);
  };

  const finishLogin = (sessionToken) => {
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
        setChallenge(readChallenge(result));
        setDigits(emptyDigits());
        setCodeMessage(null);
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

  const handleVerify = async (event) => {
    event?.preventDefault();
    if (!challenge || submitting || !isComplete(digits)) return;

    setSubmitting(true);
    setCodeMessage(null);
    setDial('unlocking');
    try {
      const { sessionToken } = await verifyOtp(challenge.token, toCode(digits));
      // Success: the challenge is spent, drop the token before moving on.
      setChallenge(null);
      setDigits(emptyDigits());
      finishLogin(sessionToken);
    } catch (err) {
      setSubmitting(false);
      setDial('error');
      setTimeout(() => setDial('idle'), 600);
      setDigits(emptyDigits());
      if (err?.response?.status === 429) {
        setCodeMessage({ tone: 'error', text: 'Too many attempts. Please wait a few minutes and try again.' });
      } else if (err?.response?.status === 401) {
        // The server gives one answer for wrong, expired, used and
        // out-of-tries, so we cannot tell which; the token stays only until
        // the code expires, Back, or success.
        setCodeMessage({ tone: 'error', text: OTP_FAILED });
      } else {
        setCodeMessage({ tone: 'error', text: extractErrorMessage(err, 'We couldn’t check that code. Please try again.') });
      }
    }
  };

  const handleResend = async () => {
    if (!challenge || resending || submitting || resendInSeconds > 0 || challenge.resendsLeft <= 0) return;
    setResending(true);
    setCodeMessage(null);
    try {
      const data = await resendOtp(challenge.token);
      setChallenge(readChallenge(data));
      setNow(Date.now());
      setDigits(emptyDigits());
      setCodeMessage({ tone: 'info', text: 'We sent a new code. The previous one no longer works.' });
    } catch (err) {
      const status = err?.response?.status;
      const body = err?.response?.data?.error;
      if (status === 401) {
        leaveCodeStep({ kind: 'other', message: 'That login timed out. Log in again to get a new code.' });
      } else if (status === 429 && Number.isFinite(body?.retryAfterSeconds)) {
        setChallenge((current) => current && { ...current, resendAvailableAt: Date.now() + body.retryAfterSeconds * 1000 });
        setCodeMessage({ tone: 'error', text: 'Please wait a moment before asking for another code.' });
      } else if (status === 429) {
        setChallenge((current) => current && { ...current, resendsLeft: 0 });
        setCodeMessage({ tone: 'error', text: body?.message || 'No more codes can be sent for this login.' });
      } else {
        setCodeMessage({ tone: 'error', text: extractErrorMessage(err, 'We couldn’t send a new code. Please try again.') });
      }
    } finally {
      setResending(false);
    }
  };

  // ---- Step 2: the emailed code ----
  if (challenge) {
    const complete = isComplete(digits);
    const resendLabel = resending
      ? 'Sending…'
      : challenge.resendsLeft <= 0
        ? 'No more resends'
        : resendInSeconds > 0
          ? `Resend code in ${formatClock(resendInSeconds)}`
          : 'Resend code';

    return (
      <AuthLayout
        title="Check your email"
        subtitle={`We sent a 6-digit code to ${email.trim()}. Enter it to finish logging in.`}
        dial={dial}
      >
        <form className={forms.form} onSubmit={handleVerify} noValidate>
          <div role="alert" aria-live="assertive">
            {codeMessage?.tone === 'error' && (
              <div className={forms.alert}>
                <Icon name="alert" />
                <p>{codeMessage.text}</p>
              </div>
            )}
          </div>
          {codeMessage?.tone === 'info' && (
            <div className={forms.notice} role="status">
              <Icon name="mail" />
              <p>{codeMessage.text}</p>
            </div>
          )}

          <div className={forms.field}>
            <span id="login-code-label" className={forms.label}>
              Login code
            </span>
            <OtpCodeInput
              digits={digits}
              onChange={(next) => {
                setDigits(next);
                setCodeMessage((current) => (current?.tone === 'error' ? null : current));
              }}
              disabled={submitting}
              invalid={codeMessage?.tone === 'error'}
              autoFocus
              labelId="login-code-label"
            />
            <p className={forms.hint} role="timer" aria-live="off" style={{ marginTop: 12 }}>
              Code expires in <strong>{formatClock(expiresInSeconds)}</strong>
            </p>
          </div>

          <button
            id="login-code-submit"
            type="submit"
            className={`${site.button} ${site.primary} ${site.block}`}
            disabled={submitting || !complete}
          >
            {submitting ? 'Checking…' : 'Verify and log in'}
          </button>

          <div className={styles.otpActions}>
            <button
              type="button"
              className={`${site.button} ${site.ghost}`}
              onClick={handleResend}
              disabled={resending || submitting || resendInSeconds > 0 || challenge.resendsLeft <= 0}
            >
              {resendLabel}
            </button>
            <button type="button" className={styles.inlineLink} onClick={() => leaveCodeStep()} disabled={submitting}>
              Back
            </button>
          </div>
          <p className={forms.hint}>Didn’t get it? Check your spam folder.</p>
        </form>
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
          {submitting ? 'Checking…' : locked ? `Locked for ${formatClock(secondsLeft)}` : 'Continue'}
        </button>
      </form>
    </AuthLayout>
  );
}

export default LoginPage;
