import { useEffect, useRef, useState } from 'react';

import Icon from '../../components/site/Icon.jsx';
import { extractErrorMessage } from '../../services/api.js';
import { CODE_LENGTH, digitsOnly, formatClock } from '../../utils/otpInput.js';
import site from '../../components/site/site.module.css';
import forms from '../../components/site/forms.module.css';
import styles from './auth.module.css';

export const CODE_DIDNT_WORK = 'That code didn’t work. Check it or ask for a new one.';

/** The server's neutral answer, as millisecond timestamps for the countdowns. */
export function readSignupChallenge(data) {
  return {
    expiresAt: new Date(data.expiresAt).getTime(),
    resendAvailableAt: new Date(data.resendAvailableAt).getTime(),
    resendsLeft: Number.isFinite(data.resendsLeft) ? data.resendsLeft : 3,
  };
}

/**
 * Step 2 of sign-up: "Enter the code we emailed". One six-digit field (numeric keypad, the browser's one-time-code
 * autofill, paste-friendly), the address it went to, "Wrong email? Go back", and a resend with its 60-second countdown.
 * Whatever goes wrong with the code, the person sees the one neutral message.
 *
 * Holds only what it needs on screen: the digits typed. The password stays in the page's state until the code is accepted,
 * and is never stored anywhere.
 */
function SignupCodeStep({ email, challenge: initial, onSubmitCode, onResend, onBack, onExpired }) {
  const [challenge, setChallenge] = useState(() => readSignupChallenge(initial));
  const [code, setCode] = useState('');
  const [message, setMessage] = useState(null); // { tone: 'error' | 'info', text }
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [now, setNow] = useState(Date.now());
  const inputRef = useRef(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const expiresInSeconds = Math.max(0, Math.ceil((challenge.expiresAt - now) / 1000));
  const resendInSeconds = Math.max(0, Math.ceil((challenge.resendAvailableAt - now) / 1000));

  useEffect(() => {
    if (expiresInSeconds === 0 && !submitting) onExpired();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresInSeconds, submitting]);

  const submit = async (value) => {
    if (submitting || value.length !== CODE_LENGTH) return;
    setSubmitting(true);
    setMessage(null);
    try {
      await onSubmitCode(value);
    } catch (err) {
      setSubmitting(false);
      setCode('');
      const status = err?.response?.status;
      if (status === 429) setMessage({ tone: 'error', text: 'Too many attempts. Please wait a few minutes and try again.' });
      else if (status === 400) setMessage({ tone: 'error', text: extractErrorMessage(err, CODE_DIDNT_WORK) });
      else setMessage({ tone: 'error', text: CODE_DIDNT_WORK });
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  const handleChange = (event) => {
    const next = digitsOnly(event.target.value).slice(0, CODE_LENGTH);
    setCode(next);
    if (message?.tone === 'error') setMessage(null);
    // The sixth digit sends it, so a pasted or autofilled code is one step.
    if (next.length === CODE_LENGTH) submit(next);
  };

  const handleResend = async () => {
    if (resending || submitting || resendInSeconds > 0 || challenge.resendsLeft <= 0) return;
    setResending(true);
    setMessage(null);
    try {
      const data = await onResend();
      setChallenge((current) => ({ ...readSignupChallenge(data), resendsLeft: Math.max(0, current.resendsLeft - 1) }));
      setNow(Date.now());
      setCode('');
      setMessage({ tone: 'info', text: 'If that address can be used, we sent a new code. The previous one no longer works.' });
    } catch (err) {
      if (err?.response?.status === 429) {
        setChallenge((current) => ({ ...current, resendAvailableAt: Date.now() + 60 * 1000 }));
        setMessage({ tone: 'error', text: 'Please wait a moment before asking for another code.' });
      } else {
        setMessage({ tone: 'error', text: 'We couldn’t send a new code right now. Please try again in a moment.' });
      }
    } finally {
      setResending(false);
    }
  };

  const resendLabel = resending
    ? 'Sending…'
    : challenge.resendsLeft <= 0
      ? 'No more resends'
      : resendInSeconds > 0
        ? `Resend code in ${formatClock(resendInSeconds)}`
        : 'Resend code';

  return (
    <form
      className={forms.form}
      onSubmit={(event) => {
        event.preventDefault();
        submit(code);
      }}
      noValidate
    >
      <p className={styles.subtitle} style={{ marginTop: 0 }}>
        We sent a 6-digit code to <span className={styles.emailEcho}>{email}</span>.
      </p>

      <div role="alert" aria-live="assertive">
        {message?.tone === 'error' && (
          <div className={forms.alert}>
            <Icon name="alert" />
            <p>{message.text}</p>
          </div>
        )}
      </div>
      {message?.tone === 'info' && (
        <div className={forms.notice} role="status">
          <Icon name="mail" />
          <p>{message.text}</p>
        </div>
      )}

      <div className={forms.field}>
        <label data-required htmlFor="signup-code" className={forms.label}>
          Code from your email
        </label>
        <input
          ref={inputRef}
          id="signup-code"
          name="signup-code"
          className={`${forms.input} ${styles.codeField}`}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          maxLength={CODE_LENGTH}
          value={code}
          onChange={handleChange}
          disabled={submitting}
          aria-invalid={message?.tone === 'error'}
          aria-describedby="signup-code-hint"
          placeholder="000000"
          spellCheck="false"
          autoCapitalize="off"
        />
        <p id="signup-code-hint" className={forms.hint} role="timer" aria-live="off">
          Code expires in <strong>{formatClock(expiresInSeconds)}</strong>
        </p>
      </div>

      <button type="submit" className={`${site.button} ${site.primary} ${site.block}`} disabled={submitting || code.length !== CODE_LENGTH}>
        {submitting ? 'Creating your vault…' : 'Verify and continue'}
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
        <button type="button" className={styles.inlineLink} onClick={onBack} disabled={submitting}>
          Wrong email? Go back
        </button>
      </div>
      <p className={forms.hint}>Didn’t get it? Check your spam folder.</p>
    </form>
  );
}

export default SignupCodeStep;
