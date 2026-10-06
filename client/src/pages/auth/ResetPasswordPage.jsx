import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import Icon from '../../components/site/Icon.jsx';
import PasswordStrengthMeter from '../../components/PasswordStrengthMeter.jsx';
import { resetPassword } from '../../services/authService.js';
import { extractErrorMessage } from '../../services/api.js';
import { validatePassword } from '../../utils/passwordPolicy.js';
import { usePageMeta } from '../../utils/usePageMeta.js';
import AuthLayout from './AuthLayout.jsx';
import PasswordInput from './PasswordInput.jsx';
import RecoveryKeyStep from './RecoveryKeyStep.jsx';
import site from '../../components/site/site.module.css';
import forms from '../../components/site/forms.module.css';
import styles from './auth.module.css';

const WIPE_CONFIRMATION = 'RESET';

/**
 * /reset-password?token=... (the link forgot-password emails out).
 * Two clearly separated paths, and the destructive one is never the
 * default:
 *   - "I have my recovery key" (selected by default): proves the key
 *     unlocks your vault before anything changes; documents are kept.
 *   - "I don't have it": starts a brand-new, empty vault. Needs the word
 *     RESET typed out, which is what sends confirmWipe: true. The response
 *     carries a new recovery key, shown once.
 */
function ResetPasswordPage() {
  usePageMeta('Reset your password', 'Choose a new Warden password, keeping your documents with your recovery key.');
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [mode, setMode] = useState('keep'); // keep | wipe
  const [recoveryKey, setRecoveryKey] = useState('');
  const [wipeText, setWipeText] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [keyError, setKeyError] = useState('');
  const [formError, setFormError] = useState('');
  const [linkDead, setLinkDead] = useState(false);
  const [result, setResult] = useState(null); // { wiped, recoveryKey? }
  const [newKeySaved, setNewKeySaved] = useState(false);

  const passwordOk = validatePassword(password).valid;
  const confirmOk = confirm.length > 0 && confirm === password;
  const pathOk = mode === 'keep' ? recoveryKey.trim().length > 0 : wipeText.trim() === WIPE_CONFIRMATION;
  const canSubmit = passwordOk && confirmOk && pathOk && !submitting;

  if (!token || linkDead) {
    return (
      <AuthLayout title="This reset link doesn't work">
        <div className={styles.stack}>
          <div className={forms.alert} role="alert">
            <Icon name="alert" />
            <p>
              {token
                ? 'It has expired (links last 30 minutes) or has already been used.'
                : 'This link is missing its reset code.'}
            </p>
          </div>
          <Link to="/forgot-password" className={`${site.button} ${site.primary} ${site.block}`}>
            Request a new reset link
          </Link>
        </div>
      </AuthLayout>
    );
  }

  if (result) {
    if (result.wiped && result.recoveryKey && !newKeySaved) {
      return (
        <AuthLayout
          title="Save your new recovery key"
          subtitle="Your password is reset and your vault starts empty. Your old recovery key no longer works; this one replaces it."
          wide
        >
          <RecoveryKeyStep
            recoveryKey={result.recoveryKey}
            continueLabel="I've saved it - continue"
            onContinue={() => setNewKeySaved(true)}
          />
        </AuthLayout>
      );
    }
    return (
      <AuthLayout title="Password reset" dial="unlocked">
        <div className={styles.stack} role="status">
          <p className={styles.subtitle} style={{ marginTop: 0 }}>
            {result.wiped
              ? 'Your new vault is ready. Every device that was signed in has been signed out.'
              : 'Your documents are exactly as they were. Every device that was signed in has been signed out.'}
          </p>
          <Link to="/login" className={`${site.button} ${site.primary} ${site.block}`}>
            Log in with your new password
          </Link>
        </div>
      </AuthLayout>
    );
  }

  const handleSubmit = async (event) => {
    event.preventDefault();
    setTouched({ password: true, confirm: true });
    if (!canSubmit) return;

    setSubmitting(true);
    setKeyError('');
    setFormError('');
    try {
      const data = await resetPassword({
        token,
        newPassword: password,
        ...(mode === 'keep' ? { recoveryKey: recoveryKey.trim() } : { confirmWipe: true }),
      });
      setResult({ wiped: Boolean(data.documentsWiped), recoveryKey: data.recoveryKey });
      window.scrollTo(0, 0);
    } catch (err) {
      const status = err?.response?.status;
      const body = err?.response?.data?.error;
      if (status === 404) setLinkDead(true);
      else if (status === 401) setKeyError('That recovery key doesn’t unlock this vault. Nothing was changed.');
      else if (status === 400 && Array.isArray(body?.errors)) setFormError(body.errors.join(' '));
      else setFormError(extractErrorMessage(err, 'We couldn’t reset your password. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout title="Reset your password" wide>
      <form className={forms.form} onSubmit={handleSubmit} noValidate>
        <div role="alert" aria-live="assertive">
          {formError && (
            <div className={forms.alert}>
              <Icon name="alert" />
              <p>{formError}</p>
            </div>
          )}
        </div>

        <fieldset className={styles.choices}>
          <legend>Do you have your recovery key?</legend>
          <label className={`${styles.choice} ${mode === 'keep' ? styles.choiceSelected : ''}`}>
            <input
              type="radio"
              name="reset-mode"
              value="keep"
              checked={mode === 'keep'}
              onChange={() => setMode('keep')}
            />
            <span>
              <span className={styles.choiceTitle}>I have my recovery key</span>
              <span className={styles.choiceBody}>Your documents are kept. Recommended.</span>
            </span>
          </label>
          <label className={`${styles.choice} ${mode === 'wipe' ? styles.choiceDangerSelected : ''}`}>
            <input
              type="radio"
              name="reset-mode"
              value="wipe"
              checked={mode === 'wipe'}
              onChange={() => setMode('wipe')}
            />
            <span>
              <span className={styles.choiceTitle}>I don&apos;t have it</span>
              <span className={styles.choiceBody}>Start over with an empty vault.</span>
            </span>
          </label>
        </fieldset>

        {mode === 'keep' ? (
          <div className={forms.field}>
            <label htmlFor="reset-recovery-key" className={forms.label}>
              Recovery key
            </label>
            <input
              id="reset-recovery-key"
              className={`${forms.input} ${forms.mono}`}
              value={recoveryKey}
              onChange={(event) => {
                setRecoveryKey(event.target.value);
                setKeyError('');
              }}
              placeholder="XXXX-XXXX-XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={Boolean(keyError)}
              aria-describedby="reset-recovery-key-error"
            />
            <p id="reset-recovery-key-error" className={forms.error} aria-live="polite">
              {keyError}
            </p>
          </div>
        ) : (
          <div className={styles.danger}>
            <p className={styles.dangerTitle}>
              <Icon name="alert" size={18} />
              All of your existing documents will be permanently deleted.
            </p>
            <p className={styles.dangerBody}>
              Without your recovery key, nobody, including us, can decrypt them. Resetting this way gives you a
              new, empty vault and a new recovery key. This can&apos;t be undone.
            </p>
            <div className={forms.field} style={{ marginTop: 16 }}>
              <label htmlFor="reset-wipe-confirm" className={forms.label}>
                Type {WIPE_CONFIRMATION} to confirm
              </label>
              <input
                id="reset-wipe-confirm"
                className={`${forms.input} ${forms.mono}`}
                value={wipeText}
                onChange={(event) => setWipeText(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
        )}

        <div className={forms.field}>
          <PasswordInput
            id="reset-password"
            label="New password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onBlur={() => setTouched((prev) => ({ ...prev, password: true }))}
            error={touched.password && !passwordOk ? 'This password doesn’t meet every requirement below yet.' : ''}
            autoComplete="new-password"
            describedBy="reset-password-rules"
          />
          <div id="reset-password-rules">
            <PasswordStrengthMeter password={password} />
          </div>
        </div>

        <PasswordInput
          id="reset-confirm"
          label="Confirm new password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          onBlur={() => setTouched((prev) => ({ ...prev, confirm: true }))}
          error={touched.confirm && !confirmOk ? 'The two passwords don’t match.' : ''}
          autoComplete="new-password"
        />

        <button
          type="submit"
          className={`${site.button} ${mode === 'wipe' ? site.danger : site.primary} ${site.block}`}
          disabled={!canSubmit}
        >
          {submitting
            ? 'Resetting…'
            : mode === 'wipe'
              ? 'Delete my documents and reset'
              : 'Reset password and keep my documents'}
        </button>
      </form>
    </AuthLayout>
  );
}

export default ResetPasswordPage;
