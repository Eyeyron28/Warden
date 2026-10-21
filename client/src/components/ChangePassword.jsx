import { useState } from 'react';

import OtpChallengePanel from './OtpChallengePanel.jsx';
import PasswordInput from '../pages/auth/PasswordInput.jsx';
import PasswordStrengthMeter from './PasswordStrengthMeter.jsx';
import { confirmPasswordChange, resendPasswordChangeCode, startPasswordChange } from '../services/passwordChangeService.js';
import { changePasswordErrors, startFailureMessage } from '../utils/passwordChange.js';
import site from './site/site.module.css';
import forms from './site/forms.module.css';
import styles from './ReminderSetting.module.css';

function ChangePassword() {
  const [step, setStep] = useState('form');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [challenge, setChallenge] = useState(null);

  const errors = changePasswordErrors({ current, next, confirm });
  const touch = (field) => setTouched((value) => ({ ...value, [field]: true }));
  const shown = (field, message) => (submitted || touched[field] ? message || '' : '');

  const clearAll = () => {
    setCurrent('');
    setNext('');
    setConfirm('');
    setTouched({});
    setSubmitted(false);
    setChallenge(null);
  };

  const handleStart = async (event) => {
    event.preventDefault();
    setDone('');
    setError('');
    setSubmitted(true);
    setTouched({ password: true, confirm: true });
    if (Object.keys(errors).length > 0 || submitting) return;
    setSubmitting(true);
    try {
      setChallenge(await startPasswordChange({ currentPassword: current, newPassword: next }));
      setStep('code');
    } catch (err) {
      setError(startFailureMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const goBack = () => {
    setChallenge(null);
    setStep('form');
  };

  return (
    <section className={styles.card} id="change-password" aria-labelledby="change-password-title">
      <h2 id="change-password-title" className={styles.title}>
        Change password
      </h2>
      <p className={styles.hint}>
        Enter your current password and a new one. We email a 6-digit code to confirm. Your other devices and trusted browsers are signed out; your
        files and recovery key stay as they are.
      </p>

      {step === 'form' && (
        <form className={forms.form} onSubmit={handleStart} noValidate>
          <PasswordInput
            id="cp-current"
            label="Current password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            error={submitted ? errors.current : ''}
            autoComplete="current-password"
          />
          <div className={forms.row2}>
            <PasswordInput
              id="cp-password"
              label="New password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              onBlur={() => touch('password')}
              error={shown('password', errors.next)}
              autoComplete="new-password"
              describedBy="cp-rules"
            />
            <PasswordInput
              id="cp-confirm"
              label="Confirm new password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              onBlur={() => touch('confirm')}
              error={shown('confirm', errors.confirm)}
              autoComplete="new-password"
            />
          </div>
          <div id="cp-rules">
            <PasswordStrengthMeter password={next} />
          </div>
          {error && (
            <div className={forms.alert} role="alert">
              <p>{error}</p>
            </div>
          )}
          <div className={forms.actionRow}>
            <button type="submit" className={`${site.button} ${site.primary} ${site.block}`} disabled={submitting}>
              {submitting ? 'Sending code…' : 'Send code'}
            </button>
          </div>
        </form>
      )}

      {step === 'code' && challenge && (
        <OtpChallengePanel
          challenge={challenge}
          onSubmitCode={(code, token) => confirmPasswordChange({ challengeToken: token, code, newPassword: next })}
          onResend={resendPasswordChangeCode}
          onVerified={() => {
            clearAll();
            setStep('form');
            setDone('Password changed. Your other devices were signed out.');
          }}
          onBack={goBack}
          onDead={(message) => {
            goBack();
            setError(message);
          }}
          submitLabel="Change password"
        />
      )}

      <p className={styles.status} role="status">
        {done}
      </p>
    </section>
  );
}

export default ChangePassword;
