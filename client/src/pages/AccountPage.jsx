import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router-dom';

import SensitiveInput from '../components/SensitiveInput.jsx';
import Icon from '../components/site/Icon.jsx';
import OtpChallengePanel from '../components/OtpChallengePanel.jsx';
import TrustedBrowsers from '../components/TrustedBrowsers.jsx';
import AuthLayout from './auth/AuthLayout.jsx';
import PasswordInput from './auth/PasswordInput.jsx';
import { getMe } from '../services/authService.js';
import { deleteAccount, requestDeleteCode, resendDeleteCode } from '../services/accountService.js';
import { extractErrorMessage } from '../services/api.js';
import { clearToken } from '../services/session.js';
import { usePageMeta } from '../utils/usePageMeta.js';
import site from '../components/site/site.module.css';
import forms from '../components/site/forms.module.css';
import styles from './auth/auth.module.css';

/**
 * Account settings: for now just the account's email and the one thing that
 * cannot be undone - deleting it (the Data Privacy Act right to erasure).
 *
 * Deleting is four deliberate steps, each of which can be walked back with
 * Back/Cancel until the last button:
 *   1. read what goes and what does not;
 *   2. master password again -> a deletion code is emailed (it cannot log in);
 *   3. the six-digit code;
 *   4. type the account email, then delete.
 * The challenge token and the code live only in this component's state.
 */
function AccountPage() {
  usePageMeta('Account', 'Your Warden account.');
  const navigate = useNavigate();

  const [accountEmail, setAccountEmail] = useState('');
  const [step, setStep] = useState('idle'); // idle | password | code | confirm
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState('');
  const [typedEmail, setTypedEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dial, setDial] = useState('idle');

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((me) => {
        if (!cancelled) setAccountEmail(me.email);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const reset = (message = '') => {
    setStep('idle');
    setPassword('');
    setChallenge(null);
    setCode('');
    setTypedEmail('');
    setBusy(false);
    setDial('idle');
    setError(message);
  };

  const handlePassword = async (event) => {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError('');
    try {
      const result = await requestDeleteCode(password);
      setPassword('');
      setChallenge(result);
      setStep('code');
    } catch (err) {
      const body = err?.response?.data?.error;
      if (body?.locked) {
        setError('Too many failed attempts. Try again in a few minutes.');
      } else if (err?.response?.status === 401) {
        setError('That password doesn’t match this account.');
      } else {
        setError(extractErrorMessage(err, 'We couldn’t start the deletion. Please try again.'));
      }
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (event) => {
    event.preventDefault();
    if (busy || typedEmail.trim().toLowerCase() !== accountEmail.toLowerCase()) return;
    setBusy(true);
    setError('');
    setDial('unlocking');
    try {
      await deleteAccount({ challengeToken: challenge.challengeToken, code, emailConfirmation: typedEmail.trim() });
      // Let go of everything held for the account. We leave this page first, and only
      // then does the session token go - clearing it while this route is still
      // mounted would bounce us to the login screen, so the navigation is
      // committed synchronously first. Dropping the token also empties the
      // decrypted thumbnail cache. The notice is plain text in router state.
      flushSync(() => navigate('/', { replace: true, state: { accountDeleted: true } }));
      clearToken();
    } catch (err) {
      setBusy(false);
      setDial('error');
      setTimeout(() => setDial('idle'), 600);
      const status = err?.response?.status;
      if (status === 401) {
        // Wrong, expired or used code (one answer for all): back to the code step.
        setCode('');
        setStep('code');
        setError('That code is incorrect or has expired. Check it, or go back and request a new one.');
      } else if (status === 400) {
        setError(extractErrorMessage(err, 'The email you typed does not match this account.'));
      } else {
        reset(extractErrorMessage(err, 'We couldn’t finish deleting your account. Nothing else has changed; please try again.'));
      }
    }
  };

  const emailMatches = typedEmail.trim().toLowerCase() === accountEmail.toLowerCase() && accountEmail !== '';

  return (
    <AuthLayout
      title="Account"
      subtitle={accountEmail ? `Signed in as ${accountEmail}.` : undefined}
      dial={step === 'idle' ? undefined : dial}
      wide
      layout="stacked"
    >
      <div className={styles.stack}>
        <TrustedBrowsers />

        <section className={styles.danger} aria-labelledby="delete-account-title">
          <h2 id="delete-account-title" className={styles.dangerTitle}>
            <Icon name="alert" size={18} />
            Delete account
          </h2>

          {error && (
            <div className={forms.alert} role="alert" style={{ marginTop: 12 }}>
              <Icon name="alert" />
              <p>{error}</p>
            </div>
          )}

          {step === 'idle' && (
            <>
              <p className={styles.dangerBody}>
                This permanently deletes your account and everything stored with it. <strong>It cannot be undone</strong>,
                and nobody, including us, can get your documents back afterwards.
              </p>
              <p className={styles.dangerBody}>
                <strong>Deleted:</strong> your documents and their previews, your folders, every share link and its
                encrypted copies, your devices and activity log, your login codes, trusted
                browsers and sessions, and the account itself (email, password hash and locked keys).
              </p>
              <p className={styles.dangerBody}>
                <strong>Not deleted, because we don&apos;t hold it:</strong> emails we already sent you, files you
                downloaded (including any zip you made with Export, which is not encrypted).
              </p>
              <button
                type="button"
                className={`${site.button} ${site.ghost}`}
                style={{ marginTop: 16 }}
                onClick={() => {
                  setError('');
                  setStep('password');
                }}
              >
                Delete my account…
              </button>
            </>
          )}

          {step === 'password' && (
            <form className={forms.form} onSubmit={handlePassword} noValidate style={{ marginTop: 16 }}>
              <p className={styles.dangerBody}>
                Step 1 of 3. Enter your master password. We&apos;ll then email a deletion code to{' '}
                <span className={styles.emailEcho}>{accountEmail}</span>.
              </p>
              <PasswordInput
                id="delete-password"
                label="Master password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="off"
                autoFocus
              />
              <div className={styles.otpActions}>
                <button
                  type="submit"
                  className={`${site.button} ${site.primary}`}
                  disabled={busy || !password}
                >
                  {busy ? 'Checking…' : 'Send me a code'}
                </button>
                <button type="button" className={styles.inlineLink} onClick={() => reset()} disabled={busy}>
                  Cancel
                </button>
              </div>
            </form>
          )}

          {step === 'code' && challenge && (
            <div style={{ marginTop: 16 }}>
              <p className={styles.dangerBody}>
                Step 2 of 3. Enter the 6-digit deletion code we emailed to{' '}
                <span className={styles.emailEcho}>{accountEmail}</span>. This code only works for deleting; it can&apos;t
                be used to log in.
              </p>
              <OtpChallengePanel
                challenge={challenge}
                // Held for the last step; the server checks it when you confirm.
                onSubmitCode={async (entered) => entered}
                onResend={(challengeToken) => resendDeleteCode(challengeToken)}
                onVerified={(entered) => {
                  setCode(entered);
                  setError('');
                  setStep('confirm');
                }}
                onBack={() => reset()}
                onDead={(message) => reset(message)}
                submitLabel="Continue"
              />
            </div>
          )}

          {step === 'confirm' && (
            <form className={forms.form} onSubmit={handleDelete} noValidate style={{ marginTop: 16 }}>
              <p className={styles.dangerBody}>
                Step 3 of 3. To confirm, type your account email exactly:{' '}
                <span className={styles.emailEcho}>{accountEmail}</span>
              </p>
              <div className={forms.field}>
                <label htmlFor="delete-email" className={forms.label}>
                  Your email
                </label>
                <SensitiveInput
                  fieldName="confirm-contact"
                  id="delete-email"
                  type="email"
                  className={forms.input}
                  value={typedEmail}
                  onChange={(event) => setTypedEmail(event.target.value)}
                  autoFocus
                />
              </div>
              <div className={styles.otpActions}>
                <button
                  type="submit"
                  className={`${site.button} ${site.primary}`}
                  style={{ background: 'var(--color-danger)', borderColor: 'var(--color-danger)' }}
                  disabled={busy || !emailMatches}
                >
                  {busy ? 'Deleting…' : 'Permanently delete my account'}
                </button>
                <button type="button" className={styles.inlineLink} onClick={() => reset()} disabled={busy}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </section>
      </div>
    </AuthLayout>
  );
}

export default AccountPage;
