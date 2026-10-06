import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import Icon from '../../components/site/Icon.jsx';
import PhoneRecoveryModal from '../../components/PhoneRecoveryModal.jsx';
import { forgotPassword } from '../../services/authService.js';
import { setToken } from '../../services/session.js';
import { usePageMeta } from '../../utils/usePageMeta.js';
import AuthLayout from './AuthLayout.jsx';
import site from '../../components/site/site.module.css';
import forms from '../../components/site/forms.module.css';
import styles from './auth.module.css';

const NEUTRAL_CONFIRMATION =
  'If an account with that email exists and is verified, we’ve sent it a link to reset your password. It expires in 30 minutes.';

/**
 * The "Forgot your password?" hub - everything the old lock screen's
 * recovery choices offered, minus USB (disabled server-side for now):
 *   - email reset link -> /reset-password, where the recovery key is
 *     entered to keep your documents;
 *   - recovery with a paired phone (PhoneRecoveryModal, unchanged).
 */
function ForgotPasswordPage() {
  usePageMeta('Forgot your password', 'Reset your Warden password with your recovery key or a paired phone.');
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [phoneOpen, setPhoneOpen] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (submitting) return;
    if (!email.trim()) {
      setError('Enter the email you signed up with.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      // The server answers the same way for every email; a failure here is
      // a network or rate-limit problem, never "no such account".
      setError(
        err?.response?.status === 429
          ? 'Too many requests. Please wait a while and try again.'
          : 'We couldn’t send the request. Check your connection and try again.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout
      title="Forgot your password?"
      subtitle="Your documents can survive this, as long as you still have your recovery key or a paired phone."
      footer={
        <span>
          Remembered it?{' '}
          <Link to="/login" className={site.textLink}>
            Back to log in
          </Link>
        </span>
      }
    >
      <div className={styles.stack}>
        {sent ? (
          <div className={forms.notice} role="status">
            <Icon name="mail" />
            <p>{NEUTRAL_CONFIRMATION}</p>
          </div>
        ) : (
          <form className={forms.form} onSubmit={handleSubmit} noValidate>
            <div className={forms.field}>
              <label htmlFor="forgot-email" className={forms.label}>
                Email
              </label>
              <input
                id="forgot-email"
                type="email"
                className={forms.input}
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setError('');
                }}
                autoComplete="email"
                inputMode="email"
                autoFocus
                aria-invalid={Boolean(error)}
                aria-describedby="forgot-email-error forgot-email-hint"
              />
              <p id="forgot-email-error" className={forms.error} aria-live="polite">
                {error}
              </p>
              <p id="forgot-email-hint" className={forms.hint}>
                We&apos;ll email you a reset link. On the reset page, enter your recovery key to keep your documents.
              </p>
            </div>
            <button type="submit" className={`${site.button} ${site.primary} ${site.block}`} disabled={submitting}>
              {submitting ? 'Sending…' : 'Email me a reset link'}
            </button>
          </form>
        )}

        <div className={styles.secondaryActions}>
          <p className={forms.hint}>Have a paired phone? It can approve a new password without the email step.</p>
          <button type="button" className={`${site.button} ${site.ghost}`} onClick={() => setPhoneOpen(true)}>
            <Icon name="phone" size={18} />
            Recover with my paired phone
          </button>
        </div>
      </div>

      {phoneOpen && (
        <PhoneRecoveryModal
          initialEmail={email.trim()}
          onClose={() => setPhoneOpen(false)}
          onRecovered={(sessionToken) => {
            setPhoneOpen(false);
            setToken(sessionToken);
            navigate('/vault', { replace: true });
          }}
        />
      )}
    </AuthLayout>
  );
}

export default ForgotPasswordPage;
