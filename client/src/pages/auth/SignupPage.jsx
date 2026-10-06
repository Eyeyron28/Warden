import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';

import Icon from '../../components/site/Icon.jsx';
import PasswordStrengthMeter from '../../components/PasswordStrengthMeter.jsx';
import { getPublicConfig, signupVault } from '../../services/authService.js';
import { extractErrorMessage } from '../../services/api.js';
import { validatePassword } from '../../utils/passwordPolicy.js';
import { useSessionToken } from '../../utils/useSessionToken.js';
import { usePageMeta } from '../../utils/usePageMeta.js';
import AuthLayout from './AuthLayout.jsx';
import PasswordInput from './PasswordInput.jsx';
import RecoveryKeyStep from './RecoveryKeyStep.jsx';
import ResendButton from './ResendButton.jsx';
import site from '../../components/site/site.module.css';
import forms from '../../components/site/forms.module.css';
import styles from './auth.module.css';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

function fieldErrors(values, { inviteRequired }) {
  const errors = {};
  const email = values.email.trim();
  if (!email) errors.email = 'Enter your email address.';
  else if (email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) errors.email = 'That email address doesn’t look right.';
  if (!validatePassword(values.password).valid) errors.password = 'This password doesn’t meet every requirement below yet.';
  if (!values.confirm) errors.confirm = 'Type the same password again.';
  else if (values.confirm !== values.password) errors.confirm = 'The two passwords don’t match.';
  if (inviteRequired && !values.invite.trim()) errors.invite = 'Signups are invite-only right now. Enter your invite code.';
  return errors;
}

/**
 * Three steps, all on this page:
 *   1. the form;
 *   2. the recovery key - the server returns it once, in the signup
 *      response, and never again, so it has to be shown here, before the
 *      email is verified (the verify link may well open on another device);
 *   3. "Check your email", with a resend button.
 *
 * The signup response is deliberately identical whether or not the email
 * already had an account (the server returns a key-shaped value either
 * way), so this page never claims an account "was created".
 */
function SignupPage() {
  usePageMeta('Create your vault', 'Create a Warden account: an encrypted vault for your important documents.');
  const token = useSessionToken();

  const [step, setStep] = useState('form'); // form | key | email
  const [values, setValues] = useState({ email: '', password: '', confirm: '', invite: '' });
  const [touched, setTouched] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [serverFieldErrors, setServerFieldErrors] = useState({});
  const [recoveryKey, setRecoveryKey] = useState(null);
  const [signupMode, setSignupMode] = useState(null); // 'open' | 'invite' | 'unknown'

  useEffect(() => {
    let cancelled = false;
    getPublicConfig()
      .then((config) => !cancelled && setSignupMode(config.signupMode))
      .catch(() => !cancelled && setSignupMode('unknown'));
    return () => {
      cancelled = true;
    };
  }, []);

  if (token) return <Navigate to="/vault" replace />;

  const inviteRequired = signupMode === 'invite';
  const showInvite = signupMode === 'invite' || signupMode === 'unknown';
  const errors = { ...fieldErrors(values, { inviteRequired }), ...serverFieldErrors };
  const visibleError = (field) => (touched[field] || serverFieldErrors[field] ? errors[field] : '');
  const isValid = Object.keys(fieldErrors(values, { inviteRequired })).length === 0;

  const update = (field) => (event) => {
    setValues((prev) => ({ ...prev, [field]: event.target.value }));
    if (serverFieldErrors[field]) setServerFieldErrors((prev) => ({ ...prev, [field]: undefined }));
    setFormError('');
  };
  const blur = (field) => () => setTouched((prev) => ({ ...prev, [field]: true }));

  const handleSubmit = async (event) => {
    event.preventDefault();
    setTouched({ email: true, password: true, confirm: true, invite: true });
    if (!isValid || submitting) return;

    setSubmitting(true);
    setFormError('');
    try {
      const response = await signupVault(
        values.email.trim(),
        values.password,
        showInvite && values.invite.trim() ? values.invite.trim() : undefined
      );
      setRecoveryKey(response.recoveryKey);
      setValues((prev) => ({ ...prev, password: '', confirm: '' }));
      setStep('key');
      window.scrollTo(0, 0);
    } catch (err) {
      const status = err?.response?.status;
      const body = err?.response?.data?.error;
      if (status === 403 && showInvite) {
        setServerFieldErrors({ invite: 'That invite code wasn’t accepted.' });
      } else if (status === 400 && Array.isArray(body?.errors)) {
        setServerFieldErrors({ password: body.errors.join(' ') });
      } else if (status === 429) {
        setFormError('Too many signup attempts. Please wait a while and try again.');
      } else {
        setFormError(extractErrorMessage(err, 'We couldn’t create your vault. Please try again.'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (step === 'key') {
    return (
      <AuthLayout
        title="Save your recovery key"
        subtitle="If you ever forget your password, this key lets you set a new one without losing anything."
        wide
      >
        <RecoveryKeyStep
          recoveryKey={recoveryKey}
          email={values.email.trim()}
          continueLabel="I've saved it - continue"
          onContinue={() => {
            setRecoveryKey(null);
            setStep('email');
            window.scrollTo(0, 0);
          }}
        />
      </AuthLayout>
    );
  }

  if (step === 'email') {
    return (
      <AuthLayout
        title="Check your email"
        footer={
          <span>
            Verified already?{' '}
            <Link to="/login" className={site.textLink}>
              Log in
            </Link>
          </span>
        }
      >
        <div className={styles.stack}>
          <p className={styles.subtitle} style={{ marginTop: 0 }}>
            If <span className={styles.emailEcho}>{values.email.trim()}</span> can be registered, we&apos;ve sent it
            a verification link. Open it to finish setting up your vault. You can&apos;t log in until you do.
          </p>
          <div className={forms.notice}>
            <Icon name="mail" />
            <p>Check your spam folder. The link expires in 24 hours.</p>
          </div>
          <ResendButton email={values.email.trim()} startCoolingDown />
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create your vault"
      subtitle="Your password protects the key to everything you store. Pick one you won't need to write down."
      footer={
        <span>
          Already have a vault?{' '}
          <Link to="/login" className={site.textLink}>
            Log in
          </Link>
        </span>
      }
    >
      <form className={forms.form} onSubmit={handleSubmit} noValidate>
        <div role="alert" aria-live="assertive">
          {formError && (
            <div className={forms.alert}>
              <Icon name="alert" />
              <p>{formError}</p>
            </div>
          )}
        </div>

        <div className={forms.field}>
          <label htmlFor="signup-email" className={forms.label}>
            Email
          </label>
          <input
            id="signup-email"
            type="email"
            className={forms.input}
            value={values.email}
            onChange={update('email')}
            onBlur={blur('email')}
            autoComplete="email"
            inputMode="email"
            maxLength={MAX_EMAIL_LENGTH}
            autoFocus
            aria-invalid={Boolean(visibleError('email'))}
            aria-describedby="signup-email-error"
          />
          <p id="signup-email-error" className={forms.error} aria-live="polite">
            {visibleError('email')}
          </p>
        </div>

        <div className={forms.field}>
          <PasswordInput
            id="signup-password"
            label="Password"
            value={values.password}
            onChange={update('password')}
            onBlur={blur('password')}
            error={visibleError('password')}
            autoComplete="new-password"
            describedBy="signup-password-rules"
          />
          <div id="signup-password-rules">
            <PasswordStrengthMeter password={values.password} />
          </div>
        </div>

        <PasswordInput
          id="signup-confirm"
          label="Confirm password"
          value={values.confirm}
          onChange={update('confirm')}
          onBlur={blur('confirm')}
          error={visibleError('confirm')}
          autoComplete="new-password"
        />

        {showInvite && (
          <div className={forms.field}>
            <label htmlFor="signup-invite" className={forms.label}>
              Invite code {!inviteRequired && <span className={forms.optional}>(if you have one)</span>}
            </label>
            <input
              id="signup-invite"
              className={`${forms.input} ${forms.mono}`}
              value={values.invite}
              onChange={update('invite')}
              onBlur={blur('invite')}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={Boolean(visibleError('invite'))}
              aria-describedby="signup-invite-error"
            />
            <p id="signup-invite-error" className={forms.error} aria-live="polite">
              {visibleError('invite')}
            </p>
          </div>
        )}

        <button
          type="submit"
          className={`${site.button} ${site.primary} ${site.block}`}
          disabled={!isValid || submitting || signupMode === null}
        >
          {submitting ? 'Creating your vault…' : 'Create vault'}
        </button>
        <p className={forms.hint}>
          By creating a vault you agree to the{' '}
          <Link to="/terms" className={site.textLink}>
            terms
          </Link>{' '}
          and{' '}
          <Link to="/privacy" className={site.textLink}>
            privacy policy
          </Link>
          .
        </p>
      </form>
    </AuthLayout>
  );
}

export default SignupPage;
