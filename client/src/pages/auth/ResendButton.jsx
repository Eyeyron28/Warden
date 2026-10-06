import { useEffect, useState } from 'react';

import { resendVerification } from '../../services/authService.js';
import site from '../../components/site/site.module.css';
import forms from '../../components/site/forms.module.css';

const COOLDOWN_SECONDS = 60;

/**
 * "Resend verification link" with a 60-second cooldown, matching the
 * server's own once-per-minute-per-email limit. Starts already cooling
 * down when a link was just sent (right after signup), so the first click
 * can't land on a 429.
 */
function ResendButton({ email, startCoolingDown = false, variant = 'ghost' }) {
  const [secondsLeft, setSecondsLeft] = useState(startCoolingDown ? COOLDOWN_SECONDS : 0);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    if (secondsLeft <= 0) return undefined;
    const timer = setTimeout(() => setSecondsLeft((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  const handleClick = async () => {
    if (!email || sending || secondsLeft > 0) return;
    setSending(true);
    setMessage('');
    setIsError(false);
    try {
      const { message: serverMessage } = await resendVerification(email);
      setMessage(serverMessage);
      setSecondsLeft(COOLDOWN_SECONDS);
    } catch (err) {
      setIsError(true);
      if (err?.response?.status === 429) {
        setMessage('A link was sent less than a minute ago. Please wait before asking for another.');
        setSecondsLeft(COOLDOWN_SECONDS);
      } else {
        setMessage('We couldn’t send a new link right now. Please try again in a moment.');
      }
    } finally {
      setSending(false);
    }
  };

  const label = sending
    ? 'Sending…'
    : secondsLeft > 0
      ? `Resend link in ${secondsLeft}s`
      : 'Resend verification link';

  return (
    <div>
      <button
        type="button"
        className={`${site.button} ${variant === 'primary' ? site.primary : site.ghost}`}
        onClick={handleClick}
        disabled={!email || sending || secondsLeft > 0}
      >
        {label}
      </button>
      <p className={isError ? forms.error : forms.hint} role="status" aria-live="polite" style={{ marginTop: 8 }}>
        {message}
      </p>
    </div>
  );
}

export default ResendButton;
