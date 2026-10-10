import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import Icon from '../components/site/Icon.jsx';
import AuthLayout from './auth/AuthLayout.jsx';
import { requestAccess, requestCode, startEmergencySession } from '../services/emergencyService.js';
import { clearToken, setToken } from '../services/session.js';
import { clearEmergencyFlag, enterEmergencyMode } from '../services/emergencyMode.js';
import { formatManila } from '../utils/activityText.js';
import { ENDED_MESSAGE } from '../utils/emergencyMode.js';
import {
  NEUTRAL_CODE_MESSAGE,
  ONLY_IF_SETUP_NOTE,
  publicFailureMessage,
  requestSentText,
} from '../utils/emergencyMessages.js';
import { isCompleteKit, normalizeKitInput } from '../utils/kitHolder.js';
import { usePageMeta } from '../utils/usePageMeta.js';
import site from '../components/site/site.module.css';
import forms from '../components/site/forms.module.css';
import styles from './EmergencyContactPage.module.css';

const STEPS = [
  { id: 'request', title: 'Request access' },
  { id: 'confirm', title: 'Confirm' },
  { id: 'open', title: 'Open the vault' },
];

const EMAIL_RE = /^[^\s@,;<>()[\]"]+@[^\s@,;<>()[\]"]+\.[^\s@,;<>()[\]"]+$/;

/**
 * /emergency: the page a trusted contact uses. No account, no sign-in, three plain steps:
 *   1. Request access: the owner's email and yours, then "Send me a code" (always the same confirmation).
 *   2. Confirm: the emailed code and the Emergency Kit code. The owner is emailed; the request is refused if that email cannot be sent.
 *   3. Open the vault: once the waiting period has ended, a NEW emailed code and the kit start a read-only session.
 *
 * Every failure is the same sentence, so nothing here reveals whether an account or setup exists. The kit is typed or
 * pasted into a field in this page's memory only: it is never stored in the browser or put in the address bar.
 */
function EmergencyContactPage() {
  usePageMeta('Emergency access', 'Request read-only access to a Warden vault you were trusted with.');
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const ended = params.get('ended') === '1';
  // The "ended" notice has been shown: from here this tab behaves like any other visitor's.
  useEffect(() => {
    clearEmergencyFlag();
  }, []);
  const [step, setStep] = useState(() => (typeof window !== 'undefined' && window.location.hash === '#open' ? 'open' : 'request'));
  const [ownerEmail, setOwnerEmail] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [code, setCode] = useState('');
  const [kit, setKit] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [sent, setSent] = useState(null); // { releaseAt }
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  // A link to /emergency#open (from the "access is available" email) lands on step 3, also when the page is already open.
  const { hash } = useLocation();
  useEffect(() => {
    if (hash === '#open') {
      setStep('open');
      setError('');
      setMessage('');
    }
  }, [hash]);

  const detailsOk = EMAIL_RE.test(ownerEmail.trim()) && EMAIL_RE.test(contactEmail.trim());
  const details = () => ({ ownerEmail: ownerEmail.trim(), contactEmail: contactEmail.trim() });

  const go = (next) => {
    setStep(next);
    setError('');
    setMessage('');
    setCode('');
  };

  // Asking for a code: the answer is the same whoever asks and whatever they typed.
  const sendCode = async (next) => {
    if (!detailsOk || busy) return;
    setBusy(true);
    setError('');
    try {
      await requestCode(details());
      setCodeSent(true);
      setMessage(NEUTRAL_CODE_MESSAGE);
      if (next) setStep(next);
    } catch (err) {
      setError(publicFailureMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitRequest = async (event) => {
    event.preventDefault();
    if (busy || code.length !== 6 || !isCompleteKit(kit)) return;
    setBusy(true);
    setError('');
    try {
      const result = await requestAccess({ ...details(), code, kit });
      setSent({ releaseAt: result.releaseAt });
      setMessage('');
      setCode('');
      setKit('');
    } catch (err) {
      setError(publicFailureMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const openVault = async (event) => {
    event.preventDefault();
    if (busy || code.length !== 6 || !isCompleteKit(kit)) return;
    setBusy(true);
    setError('');
    try {
      const result = await startEmergencySession({ ...details(), code, kit });
      // Handled exactly like a normal sign-in: the token lives in sessionStorage for this tab.
      clearToken();
      setToken(result.sessionToken);
      enterEmergencyMode({ endsAt: result.endsAt, scope: result.scope });
      setKit('');
      setCode('');
      navigate('/files', { replace: true });
    } catch (err) {
      setError(publicFailureMessage(err));
      setBusy(false);
    }
  };

  const codeFields = (onSubmit, label) => (
    <form className={forms.form} onSubmit={onSubmit} noValidate>
      <div className={forms.field}>
        <label htmlFor="ec-code" className={forms.label}>Code from your email</label>
        <input
          id="ec-code"
          className={`${forms.input} ${forms.mono}`}
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
          placeholder="6 digits"
        />
      </div>
      <div className={forms.field}>
        <label htmlFor="ec-kit" className={forms.label}>Emergency Kit code</label>
        <input
          id="ec-kit"
          className={`${forms.input} ${forms.mono}`}
          type="text"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          data-lpignore="true"
          value={kit}
          onChange={(event) => setKit(normalizeKitInput(event.target.value))}
          placeholder="ABCD-EFGH-IJKL-…"
        />
        <p className={forms.hint}>From the sheet the owner gave you. Spaces and dashes don’t matter.</p>
      </div>
      <button type="submit" className={`${site.button} ${site.primary} ${site.block}`} disabled={busy || code.length !== 6 || !isCompleteKit(kit)}>
        {busy ? 'Checking…' : label}
      </button>
    </form>
  );

  const detailFields = (
    <>
      <div className={forms.field}>
        <label htmlFor="ec-owner" className={forms.label}>The owner’s email</label>
        <input id="ec-owner" type="email" className={forms.input} autoComplete="off" inputMode="email" value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} />
      </div>
      <div className={forms.field}>
        <label htmlFor="ec-contact" className={forms.label}>Your email</label>
        <input id="ec-contact" type="email" className={forms.input} autoComplete="off" inputMode="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} />
      </div>
    </>
  );

  return (
    <AuthLayout
      title="Emergency access"
      subtitle="Someone you know named you as a trusted contact for their Warden vault. In an emergency you can ask for read-only access."
      wide
    >
      <div className={styles.stack} data-testid="emergency-contact" data-step={step}>
        {ended && (
          <div className={forms.notice} role="status" data-testid="ended-notice">
            <Icon name="lock" />
            <p><strong>{ENDED_MESSAGE}.</strong> The session ended or was turned off. You can ask for access again below.</p>
          </div>
        )}

        <ol className={styles.steps} aria-label="Steps">
          {STEPS.map((entry, index) => (
            <li key={entry.id}>
              <button type="button" className={`${styles.stepButton} ${step === entry.id ? styles.stepOn : ''}`} onClick={() => go(entry.id)} aria-current={step === entry.id ? 'step' : undefined}>
                <span className={styles.stepNumber}>{index + 1}</span> {entry.title}
              </button>
            </li>
          ))}
        </ol>

        <div role="alert" aria-live="assertive">
          {error && (
            <div className={forms.alert}>
              <Icon name="alert" />
              <p>{error}</p>
            </div>
          )}
        </div>
        {message && !error && (
          <div className={forms.notice} role="status" data-testid="neutral-message">
            <Icon name="mail" />
            <p>{message}</p>
          </div>
        )}

        {step === 'request' && (
          <form
            className={forms.form}
            onSubmit={(event) => {
              event.preventDefault();
              sendCode('confirm');
            }}
            noValidate
          >
            {detailFields}
            <button type="submit" className={`${site.button} ${site.primary} ${site.block}`} disabled={!detailsOk || busy}>
              {busy ? 'Sending…' : 'Send me a code'}
            </button>
          </form>
        )}

        {step === 'confirm' && !sent && (
          <>
            {!codeSent && <p className={forms.hint}>Start with step 1 to get a code.</p>}
            {codeFields(submitRequest, 'Send my request')}
          </>
        )}

        {step === 'confirm' && sent && (
          <div className={forms.notice} role="status" data-testid="request-sent">
            <Icon name="check" />
            <p>{requestSentText(sent.releaseAt, formatManila)}</p>
          </div>
        )}

        {step === 'open' && (
          <>
            <p className={forms.hint}>Use this once the waiting period has ended. You’ll get a new code by email.</p>
            {detailFields}
            <button type="button" className={`${site.button} ${site.ghost} ${site.block}`} disabled={!detailsOk || busy} onClick={() => sendCode(null)}>
              {busy ? 'Sending…' : 'Send me a new code'}
            </button>
            {codeFields(openVault, 'Open the vault')}
          </>
        )}

        <p className={styles.note}>{ONLY_IF_SETUP_NOTE}</p>
        <p className={styles.note}>
          Access is read-only and limited to what the owner chose. The owner is emailed when a request is made, and a request is refused if that email cannot be sent. Owner? <Link to="/login">Sign in</Link> to manage Emergency Access.
        </p>
      </div>
    </AuthLayout>
  );
}

export default EmergencyContactPage;
