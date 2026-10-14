import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';

import InviteCodeField from '../../components/InviteCodeField.jsx';
import SensitiveInput from '../../components/SensitiveInput.jsx';
import Icon from '../../components/site/Icon.jsx';
import PasswordStrengthMeter from '../../components/PasswordStrengthMeter.jsx';
import { signupResend, signupStart, signupVerify } from '../../services/authService.js';
import { setToken } from '../../services/session.js';
import { suggestEmailFix } from '../../utils/emailTypos.js';
import { clearSignupEmail, initialSignupState, nextStep, saveSignupEmail } from '../../utils/signupDraft.js';
import { cleanInviteCode, describeSignupFailure, inviteFieldError } from '../../utils/inviteCode.js';
import { useSignupConfig } from '../../utils/publicConfig.js';
import { validatePassword } from '../../utils/passwordPolicy.js';
import { useSessionToken } from '../../utils/useSessionToken.js';
import { usePageMeta } from '../../utils/usePageMeta.js';
import AuthLayout from './AuthLayout.jsx';
import PasswordInput from './PasswordInput.jsx';
import RecoveryKeyStep from './RecoveryKeyStep.jsx';
import SignupCodeStep from './SignupCodeStep.jsx';
import site from '../../components/site/site.module.css';
import forms from '../../components/site/forms.module.css';
import inviteStyles from '../../components/InviteCodeField.module.css';
import styles from './auth.module.css';

// The terms/privacy dialog is only needed once someone opens it, so it (and
// the legal text it carries) stays out of this page's own chunk.
const LegalModal = lazy(() => import('../../components/site/LegalModal.jsx'));

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
  if (inviteRequired) {
    const problem = inviteFieldError(values.invite);
    if (problem) errors.invite = problem;
  }
  return errors;
}

/**
 * Three steps, all on this page - and NO account exists until step 2 succeeds:
 *   1. the form: the server checks it and emails a 6-digit code (it creates nothing);
 *   2. "Enter the code we emailed": only the right code creates the account and signs the person in;
 *   3. the recovery key - returned once, in the answer to step 2, and never again - then into the app.
 *
 * Step 1 answers the same whether or not the address already has an account (that owner gets a notice instead of a code),
 * so this page never says whether one exists. A reload in the middle returns to step 1 with the email filled in again;
 * the password is never kept anywhere.
 */
function SignupPage() {
  usePageMeta('Create your vault', 'Create a Warden account: an encrypted vault for your important documents.');
  const token = useSessionToken();

  const navigate = useNavigate();
  const [step, setStep] = useState(() => initialSignupState().step); // form | code | key
  const [values, setValues] = useState(() => initialSignupState().values);
  const [challenge, setChallenge] = useState(null); // the neutral answer to step 1 (timestamps for the countdowns)
  const [touched, setTouched] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [serverFieldErrors, setServerFieldErrors] = useState({});
  const [recoveryKey, setRecoveryKey] = useState(null);
  // The session token is handed to the app only AFTER the recovery key screen is on screen: setting it in the same tick
  // would re-render this page as "signed in" before the step change lands, and skip the key.
  const [pendingToken, setPendingToken] = useState(null);
  useEffect(() => {
    if (step === 'key' && pendingToken) {
      setToken(pendingToken);
      setPendingToken(null);
    }
  }, [step, pendingToken]);
  // 'loading' | 'ready' | 'error': never guessed. If the settings cannot be loaded
  // the page offers a retry instead of a form that may be missing the invite field.
  const { status: configStatus, config, retry: retryConfig } = useSignupConfig();
  const signupMode = config?.signupMode ?? null; // 'open' | 'invite'
  const inviteRef = useRef(null);
  const [attempted, setAttempted] = useState(false);
  // Terms and privacy: read in a dialog (scrolled to the end of each) before
  // the agreement checkbox becomes tickable.
  const [legalTab, setLegalTab] = useState(null); // null (closed) | 'terms' | 'privacy'
  const [legalRead, setLegalRead] = useState({ terms: false, privacy: false });
  const [agreed, setAgreed] = useState(false);
  // Shown when someone tries to tick the box before reading both documents.
  const [legalNotice, setLegalNotice] = useState(false);
  const legalOpenerRef = useRef(null);

  const markLegalRead = useCallback(
    (key) => setLegalRead((prev) => (prev[key] ? prev : { ...prev, [key]: true })),
    []
  );
  const closeLegal = useCallback(() => {
    setLegalTab(null);
    requestAnimationFrame(() => legalOpenerRef.current?.focus());
  }, []);
  const openLegal = (key) => (event) => {
    legalOpenerRef.current = event.currentTarget;
    setLegalTab(key);
  };

  // Signed in is a reason to leave - except while the recovery key is on screen: the session is made at the moment the account is.
  if (token && step !== 'key') return <Navigate to="/files" replace />;

  const inviteRequired = signupMode === 'invite';
  const errors = { ...fieldErrors(values, { inviteRequired }), ...serverFieldErrors };
  const visibleError = (field) => (touched[field] || serverFieldErrors[field] ? errors[field] : '');
  const isValid = Object.keys(fieldErrors(values, { inviteRequired })).length === 0;
  const legalAllRead = legalRead.terms && legalRead.privacy;
  // Only ever a suggestion: a typo in a well-known domain is offered a one-click fix, and nothing is blocked.
  const emailSuggestion = suggestEmailFix(values.email);
  const canSubmit = isValid && agreed && legalAllRead;

  const update = (field) => (event) => {
    setValues((prev) => ({ ...prev, [field]: event.target.value }));
    if (serverFieldErrors[field]) setServerFieldErrors((prev) => ({ ...prev, [field]: undefined }));
    setFormError('');
  };
  const blur = (field) => () => setTouched((prev) => ({ ...prev, [field]: true }));

  const focusFirstProblem = (problems) => {
    const order = [
      ['invite', () => inviteRef.current],
      ['email', () => document.getElementById('signup-email')],
      ['password', () => document.getElementById('signup-password')],
      ['confirm', () => document.getElementById('signup-confirm')],
    ];
    const first = order.find(([field]) => problems[field]);
    first?.[1]()?.focus();
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setAttempted(true);
    setTouched({ email: true, password: true, confirm: true, invite: true });
    if (submitting) return;
    if (!canSubmit) {
      // The button only looks disabled (aria-disabled), so a click lands here and says what is missing.
      if (isValid && !legalAllRead) setLegalNotice(true);
      focusFirstProblem(fieldErrors(values, { inviteRequired }));
      return;
    }

    setSubmitting(true);
    setFormError('');
    try {
      const response = await signupStart({
        email: values.email.trim(),
        password: values.password,
        inviteCode: inviteRequired ? cleanInviteCode(values.invite) : undefined,
      });
      saveSignupEmail(values.email.trim());
      setChallenge(response);
      setStep(nextStep('form', 'codeSent'));
      window.scrollTo(0, 0);
    } catch (err) {
      const failure = describeSignupFailure(err);
      if (failure.kind === 'invite' && inviteRequired) {
        // Everything else stays filled in, the password included.
        setServerFieldErrors({ invite: failure.message });
        requestAnimationFrame(() => inviteRef.current?.focus());
      } else if (failure.kind === 'password') {
        setServerFieldErrors({ password: failure.message });
      } else if (failure.kind === 'email') {
        setServerFieldErrors({ email: failure.message });
        requestAnimationFrame(() => document.getElementById('signup-email')?.focus());
      } else {
        setFormError(failure.message);
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
            // The key is dropped from memory the moment this screen is left.
            setRecoveryKey(null);
            clearSignupEmail();
            navigate('/files', { replace: true });
          }}
        />
      </AuthLayout>
    );
  }

  if (step === 'code') {
    return (
      <AuthLayout title="Enter the code we emailed" wide>
        <SignupCodeStep
          email={values.email.trim()}
          challenge={challenge}
          onSubmitCode={async (code) => {
            const result = await signupVerify({ email: values.email.trim(), password: values.password, code });
            // The account exists now. The key goes on screen first; the session (and so the app) follows it.
            setRecoveryKey(result.recoveryKey);
            setValues((prev) => ({ ...prev, password: '', confirm: '', invite: '' }));
            setStep(nextStep('code', 'verified'));
            setPendingToken(result.sessionToken);
            window.scrollTo(0, 0);
          }}
          onResend={() => signupResend(values.email.trim())}
          onBack={() => {
            setStep(nextStep('code', 'back'));
            window.scrollTo(0, 0);
          }}
          onExpired={() => {
            setFormError('That code expired. Press Create vault to get a new one.');
            setStep(nextStep('code', 'expired'));
          }}
        />
      </AuthLayout>
    );
  }

  if (configStatus !== 'ready') {
    return (
      <AuthLayout title="Create your vault" subtitle="Your password protects the key to everything you store.">
        {configStatus === 'loading' ? (
          <p className={styles.subtitle} role="status" style={{ marginTop: 0 }}>
            Checking the sign-up settings…
          </p>
        ) : (
          <div className={styles.stack}>
            <div className={forms.alert} role="alert">
              <Icon name="alert" />
              <p>
                We couldn’t load the sign-up settings, so we can’t show the form yet. Check your connection and try
                again.
              </p>
            </div>
            <button type="button" className={`${site.button} ${site.primary} ${site.block}`} onClick={retryConfig}>
              Try again
            </button>
          </div>
        )}
      </AuthLayout>
    );
  }

  const accessLine = config.requestAccessText || 'Ask the person who runs this Warden for a code.';
  const agreeProblem = attempted && !agreed && !legalNotice;

  return (
    <AuthLayout
      title="Create your vault"
      subtitle={
        inviteRequired
          ? 'Access is by invitation. Your password protects the key to everything you store; pick one you won’t need to write down.'
          : 'Your password protects the key to everything you store. Pick one you won\'t need to write down.'
      }
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

        {/* Related fields share a row on a desktop landscape window (forms.row2); one column elsewhere. */}
        <div className={forms.row2}>
          {inviteRequired && (
            <InviteCodeField
              value={values.invite}
              onChange={(next) => update('invite')({ target: { value: next } })}
              onBlur={blur('invite')}
              error={visibleError('invite')}
              inputRef={inviteRef}
              autoFocus
            >
              <p className={`${inviteStyles.request} ${forms.hintOptional}`}>
                <strong>No code?</strong> {accessLine}
              </p>
            </InviteCodeField>
          )}

          <div className={forms.field}>
            <label htmlFor="signup-email" className={forms.label}>
              Email
            </label>
            <SensitiveInput
              fieldName="signup-contact"
              id="signup-email"
              type="email"
              className={forms.input}
              value={values.email}
              onChange={update('email')}
              onBlur={blur('email')}
              inputMode="email"
              maxLength={MAX_EMAIL_LENGTH}
              autoFocus={!inviteRequired}
              aria-invalid={Boolean(visibleError('email'))}
              aria-describedby="signup-email-error"
            />
            <p id="signup-email-error" className={forms.error} aria-live="polite">
              {visibleError('email')}
            </p>
            {emailSuggestion && touched.email && (
              <p className={forms.hint} role="status" data-testid="email-suggestion">
                Did you mean{' '}
                <button
                  type="button"
                  className={site.textLink}
                  onClick={() => {
                    setValues((prev) => ({ ...prev, email: emailSuggestion }));
                    setServerFieldErrors((prev) => ({ ...prev, email: undefined }));
                  }}
                >
                  {emailSuggestion}
                </button>
                ?
              </p>
            )}
          </div>
        </div>

        <div className={forms.row2}>
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
          <PasswordInput
            id="signup-confirm"
            label="Confirm password"
            value={values.confirm}
            onChange={update('confirm')}
            onBlur={blur('confirm')}
            error={visibleError('confirm')}
            autoComplete="new-password"
          />
        </div>
        <div id="signup-password-rules">
          <PasswordStrengthMeter password={values.password} />
        </div>

        <div className={forms.actionRow}>
        <div className={forms.field}>
          <label className={forms.checkboxRow}>
            <input
              type="checkbox"
              checked={agreed}
              onChange={(event) => {
                // Not disabled, so it looks and focuses like any checkbox: until both
                // documents are read, a click or Space just explains why it did not tick.
                if (!legalAllRead) {
                  setLegalNotice(true);
                  return;
                }
                setAgreed(event.target.checked);
              }}
              aria-describedby="signup-legal-hint"
            />
            <span>
              I have read and agree to the{' '}
              <button type="button" className={site.textLink} onClick={openLegal('terms')}>
                Terms of use
              </button>{' '}
              and the{' '}
              <button type="button" className={site.textLink} onClick={openLegal('privacy')}>
                Privacy policy
              </button>
              .
            </span>
          </label>
          <p
            id="signup-legal-hint"
            className={(legalNotice && !legalAllRead) || agreeProblem ? forms.error : forms.hint}
            aria-live="polite"
          >
            {legalAllRead
              ? agreeProblem
                ? 'Tick the box to agree and continue.'
                : 'Thanks for reading. Tick the box to continue.'
              : legalNotice
                ? 'Please read the Terms of use and Privacy policy first. '
                : `Read both documents to be able to tick this${
                    legalRead.terms || legalRead.privacy
                      ? ` (still to read: ${legalRead.terms ? 'Privacy policy' : 'Terms of use'})`
                      : ''
                  }.`}
            {legalNotice && !legalAllRead && (
              <button type="button" className={site.textLink} onClick={openLegal(legalRead.terms ? 'privacy' : 'terms')}>
                Open the {legalRead.terms ? 'Privacy policy' : 'Terms of use'}
              </button>
            )}
          </p>
        </div>

        {/* aria-disabled, not disabled: it looks and is announced as unavailable, but a click
            (or Enter) still lands on the form and shows what is missing. */}
        <button
          type="submit"
          className={`${site.button} ${site.primary} ${site.block}`}
          aria-disabled={!canSubmit || submitting}
          style={!canSubmit || submitting ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
        >
          {submitting ? 'Creating your vault…' : 'Create vault'}
        </button>
        </div>
      </form>

      {legalTab && (
        <Suspense fallback={null}>
          <LegalModal
            tab={legalTab}
            onTabChange={setLegalTab}
            read={legalRead}
            onRead={markLegalRead}
            onClose={closeLegal}
          />
        </Suspense>
      )}
    </AuthLayout>
  );
}

export default SignupPage;
