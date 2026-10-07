import { useEffect, useState } from 'react';

import Icon from './site/Icon.jsx';
import OtpCodeInput from './OtpCodeInput.jsx';
import { extractErrorMessage } from '../services/api.js';
import { emptyDigits, formatClock, isComplete, toCode } from '../utils/otpInput.js';
import site from './site/site.module.css';
import forms from './site/forms.module.css';
import styles from '../pages/auth/auth.module.css';

const CODE_FAILED = 'That code is incorrect or has expired. Check it and try again, or go back and start again.';

/** A server challenge, turned into millisecond timestamps for the countdowns. */
export function readChallenge(data) {
  return {
    token: data.challengeToken,
    expiresAt: new Date(data.expiresAt).getTime(),
    resendAvailableAt: new Date(data.resendAvailableAt).getTime(),
    resendsLeft: data.resendsLeft,
  };
}

/**
 * The emailed-code step, shared by every flow that uses one (logging in,
 * finishing a phone recovery, deleting an account): six boxes, an expiry
 * countdown, "Resend code" with its cooldown, and "Back".
 *
 * The challenge token lives ONLY in this component's state - never in
 * storage, the URL or router state - and is dropped when the component goes
 * away (success, Back, expiry). What happens with the code is the caller's
 * business: `onSubmitCode(code, token)` runs it (e.g. verify-otp, or just
 * holding it for the next step); if it resolves, `onVerified(result)` fires.
 *
 * @param {{
 *   challenge: object,                       // the server's challenge payload
 *   onSubmitCode: (code: string, token: string) => Promise<any>,
 *   onResend: (token: string) => Promise<object>,
 *   onVerified: (result: any) => void,
 *   onBack: () => void,
 *   onDead: (message: string) => void,       // expired, or the server dropped it
 *   onStatus?: (status: 'idle' | 'unlocking' | 'error') => void,
 *   submitLabel?: string,
 *   busyLabel?: string,
 * }} props
 */
function OtpChallengePanel({
  challenge: initialChallenge,
  onSubmitCode,
  onResend,
  onVerified,
  onBack,
  onDead,
  onStatus = () => {},
  submitLabel = 'Verify and continue',
  busyLabel = 'Checking…',
}) {
  const [challenge, setChallenge] = useState(() => readChallenge(initialChallenge));
  const [digits, setDigits] = useState(emptyDigits);
  const [message, setMessage] = useState(null); // { tone: 'error' | 'info', text }
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const expiresInSeconds = Math.max(0, Math.ceil((challenge.expiresAt - now) / 1000));
  const resendInSeconds = Math.max(0, Math.ceil((challenge.resendAvailableAt - now) / 1000));

  // The code ran out: the server has dropped the challenge, so let go of it.
  useEffect(() => {
    if (expiresInSeconds === 0 && !submitting) onDead('That code expired. Start again to get a new one.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresInSeconds, submitting]);

  const handleSubmit = async (event) => {
    event?.preventDefault();
    if (submitting || !isComplete(digits)) return;

    setSubmitting(true);
    setMessage(null);
    onStatus('unlocking');
    try {
      const result = await onSubmitCode(toCode(digits), challenge.token);
      onVerified(result);
    } catch (err) {
      setSubmitting(false);
      onStatus('error');
      setTimeout(() => onStatus('idle'), 600);
      setDigits(emptyDigits());
      if (err?.response?.status === 429) {
        setMessage({ tone: 'error', text: 'Too many attempts. Please wait a few minutes and try again.' });
      } else if (err?.response?.status === 401) {
        // One answer for wrong, expired, used and out-of-tries, so we cannot
        // tell which; the token stays only until the code expires or Back.
        setMessage({ tone: 'error', text: CODE_FAILED });
      } else {
        setMessage({ tone: 'error', text: extractErrorMessage(err, 'We couldn’t check that code. Please try again.') });
      }
    }
  };

  // The sixth digit submits, so a pasted or autofilled code is one step. A
  // failed or resent code clears the boxes, so this cannot loop.
  useEffect(() => {
    if (!submitting && isComplete(digits)) handleSubmit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digits]);

  const handleResend = async () => {
    if (resending || submitting || resendInSeconds > 0 || challenge.resendsLeft <= 0) return;
    setResending(true);
    setMessage(null);
    try {
      const data = await onResend(challenge.token);
      setChallenge(readChallenge(data));
      setNow(Date.now());
      setDigits(emptyDigits());
      setMessage({ tone: 'info', text: 'We sent a new code. The previous one no longer works.' });
    } catch (err) {
      const status = err?.response?.status;
      const body = err?.response?.data?.error;
      if (status === 401) {
        onDead('That attempt timed out. Start again to get a new code.');
      } else if (status === 429 && Number.isFinite(body?.retryAfterSeconds)) {
        setChallenge((current) => ({ ...current, resendAvailableAt: Date.now() + body.retryAfterSeconds * 1000 }));
        setMessage({ tone: 'error', text: 'Please wait a moment before asking for another code.' });
      } else if (status === 429) {
        setChallenge((current) => ({ ...current, resendsLeft: 0 }));
        setMessage({ tone: 'error', text: body?.message || 'No more codes can be sent right now.' });
      } else {
        setMessage({ tone: 'error', text: extractErrorMessage(err, 'We couldn’t send a new code. Please try again.') });
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
    <form className={forms.form} onSubmit={handleSubmit} noValidate>
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
        <span id="otp-code-label" className={forms.label}>
          Code from your email
        </span>
        <OtpCodeInput
          digits={digits}
          onChange={(next) => {
            setDigits(next);
            setMessage((current) => (current?.tone === 'error' ? null : current));
          }}
          disabled={submitting}
          invalid={message?.tone === 'error'}
          autoFocus
          labelId="otp-code-label"
        />
        <p className={forms.hint} role="timer" aria-live="off" style={{ marginTop: 12 }}>
          Code expires in <strong>{formatClock(expiresInSeconds)}</strong>
        </p>
      </div>

      <button
        type="submit"
        className={`${site.button} ${site.primary} ${site.block}`}
        disabled={submitting || !isComplete(digits)}
      >
        {submitting ? busyLabel : submitLabel}
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
          Back
        </button>
      </div>
      <p className={forms.hint}>Didn’t get it? Check your spam folder.</p>
    </form>
  );
}

export default OtpChallengePanel;
