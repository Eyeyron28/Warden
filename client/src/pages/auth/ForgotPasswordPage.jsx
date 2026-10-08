import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import SensitiveInput from '../../components/SensitiveInput.jsx';
import Icon from '../../components/site/Icon.jsx';
import OtpChallengePanel from '../../components/OtpChallengePanel.jsx';
import PhoneRecoveryModal from '../../components/PhoneRecoveryModal.jsx';
import {
  requestPasswordReset,
  resendPasswordResetCode,
  resetPasswordStartOver,
  resetPasswordWithRecoveryKey,
  resetPasswordWithRecoveryKeyOnly,
  verifyPasswordResetCode,
} from '../../services/authService.js';
import { setToken } from '../../services/session.js';
import { STEPS, backStep, describeResetFailure, recoveryKeyProblem } from '../../utils/passwordReset.js';
import { usePageMeta } from '../../utils/usePageMeta.js';
import AuthLayout from './AuthLayout.jsx';
import RecoveryKeyStep from './RecoveryKeyStep.jsx';
import { NewPasswordFields, RecoveryKeyField, passwordIsValid } from './ResetFields.jsx';
import StepProgress from './StepProgress.jsx';
import site from '../../components/site/site.module.css';
import forms from '../../components/site/forms.module.css';
import styles from './auth.module.css';

const STEP_NOTICE = 'For your security each code works once. Request a new code to continue.';

/**
 * Forgot password, in three steps (and one side door):
 *
 *   1. Email         - the same answer for every address; a code is emailed only if there is a verified account.
 *   2. Code          - six boxes, countdown, resend; "Try another way" for people who cannot use their email.
 *   3. New password  - choose HOW: with the recovery key (the vault is kept) or without it (the vault is erased).
 *   side door: "Try another way" - the recovery key alone, no emailed code, nothing erased.
 *
 * Nothing is logged in by a reset: every path ends at the login page.
 *
 * Secrets (the code challenge, the reset ticket, the recovery key, passwords, a new
 * recovery key) live ONLY in this component's state - never in storage, the URL or
 * router state - and are cleared on Back, on failure, on success and when the page
 * goes away. Esc is Back.
 */
function ForgotPasswordPage() {
  usePageMeta('Reset your password', 'Reset your Warden password with an emailed code and your recovery key.');
  const navigate = useNavigate();

  const [step, setStep] = useState('email'); // email | code | choose | keep | wipeWarn | wipeForm | newKey | keyOnly
  const [email, setEmail] = useState('');
  const [challenge, setChallenge] = useState(null);
  const [ticket, setTicket] = useState(null);
  const [newRecoveryKey, setNewRecoveryKey] = useState(null);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [confirmEmail, setConfirmEmail] = useState('');
  const [touched, setTouched] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  const [formError, setFormError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [phoneOpen, setPhoneOpen] = useState(false);
  // Screens with no text field (the two choices, the warning) put focus on their first button.
  const firstButtonRef = useRef(null);
  useEffect(() => {
    if (step === 'choose' || step === 'wipeWarn') firstButtonRef.current?.focus();
  }, [step]);

  const clearSecrets = useCallback(() => {
    setRecoveryKey('');
    setPassword('');
    setConfirm('');
  }, []);

  // Whatever is still in memory goes when the page does.
  useEffect(
    () => () => {
      setChallenge(null);
      setTicket(null);
      setNewRecoveryKey(null);
    },
    []
  );

  const resetMessages = () => {
    setFormError('');
    setFieldErrors({});
    setTouched({});
  };

  const touch = (field) => setTouched((prev) => ({ ...prev, [field]: true }));
  const focusLater = (id) => requestAnimationFrame(() => document.getElementById(id)?.focus());

  const goBack = useCallback(() => {
    const target = backStep(step);
    if (!target || submitting) return;
    clearSecrets();
    resetMessages();
    if (step === 'code') setChallenge(null);
    if (step === 'choose') {
      setTicket(null);
      setChallenge(null);
      setNotice(STEP_NOTICE);
    }
    if (target === 'email' && step !== 'choose') setNotice('');
    setStep(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, submitting, clearSecrets]);

  // Esc is Back (not while the phone dialog, which has its own Esc, is open).
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape' && !phoneOpen && !event.defaultPrevented) goBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goBack, phoneOpen]);

  const startAgain = (message) => {
    clearSecrets();
    resetMessages();
    setTicket(null);
    setChallenge(null);
    setNotice(message || '');
    setStep('email');
  };

  /** One place for what a failed reset request does to the screen. */
  const handleFailure = (err, { keyId, confirmId } = {}) => {
    const failure = describeResetFailure(err);
    clearSecrets();
    if (failure.kind === 'ticket') {
      startAgain(failure.message);
      return;
    }
    setFormError('');
    setFieldErrors({});
    setTouched({});
    if (failure.kind === 'key' && keyId) {
      setFieldErrors({ key: failure.message });
      focusLater(keyId);
    } else if (failure.kind === 'mismatch' && confirmId) {
      setFieldErrors({ confirmEmail: failure.message });
      focusLater(confirmId);
    } else if (failure.kind === 'policy') {
      setFieldErrors({ password: failure.message });
    } else {
      setFormError(failure.message);
    }
  };

  const finishAtLogin = (kind) => {
    clearSecrets();
    setTicket(null);
    setChallenge(null);
    setNewRecoveryKey(null);
    navigate('/login', { replace: true, state: { passwordReset: kind } });
  };

  // ---- step 1 ----
  const handleStart = async (event) => {
    event.preventDefault();
    if (submitting) return;
    if (!email.trim()) {
      setFormError('Enter the email you signed up with.');
      return;
    }
    setSubmitting(true);
    setFormError('');
    setNotice('');
    try {
      setChallenge(await requestPasswordReset(email.trim()));
      setStep('code');
    } catch (err) {
      // The server answers the same way for every address, so a failure here is
      // a limit or the network - never "no such account".
      setFormError(
        err?.response?.status === 429
          ? 'Too many requests. Please wait a while and try again.'
          : 'We couldn’t send the request. Check your connection and try again.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const goKeyOnly = () => {
    clearSecrets();
    resetMessages();
    setChallenge(null);
    setNotice('');
    setStep('keyOnly');
  };

  // ---- step 3: with the recovery key ----
  const passwordOk = passwordIsValid(password);
  const confirmOk = confirm.length > 0 && confirm === password;
  const keyOk = recoveryKeyProblem(recoveryKey) === '';

  const handleKeep = async (event) => {
    event.preventDefault();
    setTouched({ key: true, password: true, confirm: true });
    if (submitting || !keyOk || !passwordOk || !confirmOk) return;
    setSubmitting(true);
    setFieldErrors({});
    setFormError('');
    try {
      await resetPasswordWithRecoveryKey({ resetTicket: ticket, recoveryKey, newPassword: password });
      finishAtLogin('kept');
    } catch (err) {
      handleFailure(err, { keyId: 'reset-key' });
    } finally {
      setSubmitting(false);
    }
  };

  // ---- step 3: without it (start over) ----
  const confirmEmailOk = confirmEmail.trim().toLowerCase() === email.trim().toLowerCase() && confirmEmail.trim() !== '';

  const handleWipe = async (event) => {
    event.preventDefault();
    setTouched({ confirmEmail: true, password: true, confirm: true });
    if (submitting || !confirmEmailOk || !passwordOk || !confirmOk) return;
    setSubmitting(true);
    setFieldErrors({});
    setFormError('');
    try {
      const data = await resetPasswordStartOver({ resetTicket: ticket, confirmEmail: confirmEmail.trim(), newPassword: password });
      clearSecrets();
      setTicket(null);
      setNewRecoveryKey(data.recoveryKey);
      setStep('newKey');
      window.scrollTo(0, 0);
    } catch (err) {
      handleFailure(err, { confirmId: 'reset-confirm-email' });
    } finally {
      setSubmitting(false);
    }
  };

  // ---- side door: the recovery key alone ----
  const handleKeyOnly = async (event) => {
    event.preventDefault();
    setTouched({ email: true, key: true, password: true, confirm: true });
    if (submitting || !email.trim() || !keyOk || !passwordOk || !confirmOk) return;
    setSubmitting(true);
    setFieldErrors({});
    setFormError('');
    try {
      await resetPasswordWithRecoveryKeyOnly({ email: email.trim(), recoveryKey, newPassword: password });
      finishAtLogin('kept');
    } catch (err) {
      const failure = describeResetFailure(err);
      clearSecrets();
      // One generic message for every failure; never "no such account".
      setFormError(failure.kind === 'rate' ? failure.message : failure.kind === 'policy' ? failure.message : 'The email or recovery key is incorrect.');
      focusLater('keyonly-key');
    } finally {
      setSubmitting(false);
    }
  };

  const progress = STEPS[step];
  const backButton = (label = 'Back') => (
    <button type="button" className={styles.inlineLink} onClick={goBack} disabled={submitting}>
      {label}
    </button>
  );
  const alert = (
    <div role="alert" aria-live="assertive">
      {formError && (
        <div className={forms.alert}>
          <Icon name="alert" />
          <p>{formError}</p>
        </div>
      )}
    </div>
  );
  const loginFooter = (
    <span>
      Remembered it?{' '}
      <Link to="/login" className={site.textLink}>
        Back to log in
      </Link>
    </span>
  );

  // ---- screens ----

  if (step === 'newKey') {
    return (
      <AuthLayout
        title="Save your new recovery key"
        subtitle="Your password is reset and your vault starts empty. Your old recovery key no longer works; this one replaces it."
        wide
      >
        <StepProgress current={3} />
        <RecoveryKeyStep
          recoveryKey={newRecoveryKey}
          email={email.trim()}
          continueLabel="I've saved it - continue to log in"
          onContinue={() => finishAtLogin('wiped')}
        />
      </AuthLayout>
    );
  }

  if (step === 'code' && challenge) {
    return (
      <AuthLayout
        title="Enter the code"
        subtitle="If an account exists for this address, we've sent a 6-digit code. It works once."
        footer={loginFooter}
      >
        <StepProgress current={2} />
        <OtpChallengePanel
          challenge={challenge}
          onSubmitCode={(code, token) => verifyPasswordResetCode(token, code)}
          onResend={resendPasswordResetCode}
          onVerified={({ resetTicket }) => {
            setTicket(resetTicket);
            setChallenge(null);
            resetMessages();
            setStep('choose');
          }}
          onBack={goBack}
          onDead={(message) => startAgain(message)}
          submitLabel="Verify code"
          footer={
            <div className={styles.tryAnother}>
              <button type="button" className={styles.tryAnotherButton} onClick={goKeyOnly}>
                Try another way
                <Icon name="arrowRight" size={16} />
              </button>
              <p className={forms.hint}>Can’t get the email? Reset with just your recovery key.</p>
            </div>
          }
        />
      </AuthLayout>
    );
  }

  if (step === 'choose') {
    return (
      <AuthLayout title="How do you want to set your new password?" subtitle="Your code worked. Choose how to continue." footer={loginFooter} wide>
        <StepProgress current={3} />
        <div className={styles.stack}>
          <div className={styles.optionList} role="group" aria-label="Ways to set a new password">
            <button type="button" className={`${styles.option} ${styles.optionPrimary}`} onClick={() => { resetMessages(); setStep('keep'); }} ref={firstButtonRef}>
              <span className={styles.optionTitle}>
                I have my recovery key <span className={styles.badge}>Recommended</span>
              </span>
              <span className={styles.optionBody}>Your files, folders and shares are kept exactly as they are.</span>
            </button>
            <button type="button" className={styles.option} onClick={() => { resetMessages(); setStep('wipeWarn'); }}>
              <span className={styles.optionTitle}>I don’t have my recovery key</span>
              <span className={styles.optionBody}>You can still get in, but your vault is erased and you start with an empty one.</span>
            </button>
          </div>
          <div className={styles.otpActions}>{backButton('Back')}</div>
        </div>
      </AuthLayout>
    );
  }

  if (step === 'keep') {
    return (
      <AuthLayout title="Use your recovery key" subtitle="Enter it, then choose a new password. Nothing is erased." footer={loginFooter} wide>
        <StepProgress current={3} />
        <form className={forms.form} onSubmit={handleKeep} noValidate>
          {alert}
          <RecoveryKeyField
            id="reset-key"
            value={recoveryKey}
            onChange={(value) => {
              setRecoveryKey(value);
              setFieldErrors((prev) => ({ ...prev, key: '' }));
            }}
            onBlur={() => touch('key')}
            touched={touched.key}
            error={fieldErrors.key}
            autoFocus
          />
          <NewPasswordFields
            idPrefix="reset"
            password={password}
            confirm={confirm}
            onPassword={setPassword}
            onConfirm={setConfirm}
            touched={touched}
            onTouch={touch}
            passwordError={fieldErrors.password}
          />
          <p className={`${forms.hint} ${forms.hintOptional}`}>
            A wrong key changes nothing. After 5 wrong keys this reset session ends and you start again.
          </p>
          <div className={forms.actionRow}>
            <button type="submit" className={`${site.button} ${site.primary} ${site.block}`} disabled={submitting}>
              {submitting ? 'Resetting…' : 'Reset password and keep my files'}
            </button>
            {backButton('Back')}
          </div>
        </form>
      </AuthLayout>
    );
  }

  if (step === 'wipeWarn') {
    return (
      <AuthLayout title="Without your recovery key, your vault is erased" footer={loginFooter} wide>
        <StepProgress current={3} />
        <div className={styles.stack}>
          <div className={styles.danger} role="alert">
            <p className={styles.dangerTitle}>
              <Icon name="alert" size={18} />
              This permanently deletes:
            </p>
            <ul className={styles.dangerList}>
              <li>all your files and folders</li>
              <li>everything in Trash</li>
              <li>every share link</li>
              <li>every paired phone</li>
              <li>every trusted browser</li>
            </ul>
            <p className={styles.dangerBody}>
              Nobody, including us, can decrypt those files without your recovery key. You keep your account and email;
              you get a new, empty vault and a <strong>new recovery key</strong>. This can’t be undone.
            </p>
          </div>
          <div className={styles.otpActions}>
            <button type="button" className={`${site.button} ${site.ghost}`} onClick={goBack} ref={firstButtonRef}>
              Go back
            </button>
            <button
              type="button"
              className={`${site.button} ${site.danger}`}
              onClick={() => {
                resetMessages();
                setStep('wipeForm');
              }}
            >
              I understand, continue
            </button>
          </div>
        </div>
      </AuthLayout>
    );
  }

  if (step === 'wipeForm') {
    return (
      <AuthLayout title="Confirm and choose a new password" subtitle="Your vault will be erased and replaced." footer={loginFooter} wide>
        <StepProgress current={3} />
        <form className={forms.form} onSubmit={handleWipe} noValidate>
          {alert}
          <div className={forms.field}>
            <label htmlFor="reset-confirm-email" className={forms.label}>
              Type your account email to confirm
            </label>
            <SensitiveInput
              fieldName="wipe-contact"
              id="reset-confirm-email"
              type="email"
              className={forms.input}
              value={confirmEmail}
              onChange={(event) => {
                setConfirmEmail(event.target.value);
                setFieldErrors((prev) => ({ ...prev, confirmEmail: '' }));
              }}
              onBlur={() => touch('confirmEmail')}
              inputMode="email"
              autoFocus
              aria-invalid={Boolean(fieldErrors.confirmEmail || (touched.confirmEmail && !confirmEmailOk))}
              aria-describedby="reset-confirm-email-error"
            />
            <p id="reset-confirm-email-error" className={forms.error} aria-live="polite">
              {fieldErrors.confirmEmail || (touched.confirmEmail && !confirmEmailOk ? 'That doesn’t match the email you started with.' : '')}
            </p>
          </div>
          <NewPasswordFields
            idPrefix="wipe"
            password={password}
            confirm={confirm}
            onPassword={setPassword}
            onConfirm={setConfirm}
            touched={touched}
            onTouch={touch}
            passwordError={fieldErrors.password}
          />
          <div className={forms.actionRow}>
            <button type="submit" className={`${site.button} ${site.danger} ${site.block}`} disabled={submitting}>
              {submitting ? 'Erasing and resetting…' : 'Erase my vault and set this password'}
            </button>
            {backButton('Back')}
          </div>
        </form>
      </AuthLayout>
    );
  }

  if (step === 'keyOnly') {
    return (
      <AuthLayout
        title="Reset with your recovery key"
        subtitle="No email code is needed. Your vault is kept; nothing is erased. Use this only if you can’t get the code."
        footer={loginFooter}
        wide
      >
        <form className={forms.form} onSubmit={handleKeyOnly} noValidate>
          {alert}
        <div className={forms.row2}>
          <div className={forms.field}>
            <label htmlFor="keyonly-email" className={forms.label}>
              Email
            </label>
            <SensitiveInput
              fieldName="keyonly-contact"
              id="keyonly-email"
              type="email"
              className={forms.input}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              onBlur={() => touch('email')}
              inputMode="email"
              autoFocus
              aria-invalid={Boolean(touched.email && !email.trim())}
              aria-describedby="keyonly-email-error"
            />
            <p id="keyonly-email-error" className={forms.error} aria-live="polite">
              {touched.email && !email.trim() ? 'Enter the email you signed up with.' : ''}
            </p>
          </div>
          <RecoveryKeyField
            id="keyonly-key"
            value={recoveryKey}
            onChange={setRecoveryKey}
            onBlur={() => touch('key')}
            touched={touched.key}
          />
        </div>
          <NewPasswordFields
            idPrefix="keyonly"
            password={password}
            confirm={confirm}
            onPassword={setPassword}
            onConfirm={setConfirm}
            touched={touched}
            onTouch={touch}
            passwordError={fieldErrors.password}
          />
          <p className={`${forms.hint} ${forms.hintOptional}`}>
            Wrong guesses are limited and slow down. We’ll email the account to say the password was changed.
          </p>
          <div className={forms.actionRow}>
            <button type="submit" className={`${site.button} ${site.primary} ${site.block}`} disabled={submitting}>
              {submitting ? 'Resetting…' : 'Reset password and keep my files'}
            </button>
            {backButton('Back')}
          </div>
        </form>
      </AuthLayout>
    );
  }

  // ---- step 1: email ----
  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Enter your email and we’ll send a 6-digit code."
      footer={loginFooter}
    >
      <StepProgress current={progress || 1} />
      <div className={styles.stack}>
        {notice && (
          <div className={forms.notice} role="status">
            <Icon name="mail" />
            <p>{notice}</p>
          </div>
        )}
        <form className={forms.form} onSubmit={handleStart} noValidate>
          {alert}
          <div className={forms.field}>
            <label htmlFor="forgot-email" className={forms.label}>
              Email
            </label>
            <SensitiveInput
              fieldName="forgot-contact"
              id="forgot-email"
              type="email"
              className={forms.input}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setFormError('');
              }}
              inputMode="email"
              autoFocus
              aria-describedby="forgot-email-hint"
            />
            <p id="forgot-email-hint" className={forms.hint}>
              If an account exists for this address, we’ll email the code. For your privacy, this page looks the same either way.
            </p>
          </div>
          <button type="submit" className={`${site.button} ${site.primary} ${site.block}`} disabled={submitting}>
            {submitting ? 'Sending…' : 'Email me a code'}
          </button>
        </form>

        <div className={styles.secondaryActions}>
          <p className={forms.hint}>Can’t use your email? You can reset with just your recovery key.</p>
          <button type="button" className={styles.tryAnotherButton} onClick={goKeyOnly}>
            Try another way
            <Icon name="arrowRight" size={16} />
          </button>
        </div>
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
            navigate('/files', { replace: true });
          }}
        />
      )}
    </AuthLayout>
  );
}

export default ForgotPasswordPage;
