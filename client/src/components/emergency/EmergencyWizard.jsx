import { useEffect, useState } from 'react';

import FreshCodeDialog from './FreshCodeDialog.jsx';
import { extractErrorMessage } from '../../services/api.js';
import { listFolderChoices, setupEmergency } from '../../services/emergencyService.js';
import {
  MAX_FOLDERS,
  STEPS,
  STEP_TITLES,
  folderTree,
  initialWizardState,
  nextStep,
  previousStep,
  setupBody,
  stepNumber,
  stepValidation,
  summaryLines,
  toggleFolder,
  waitChoices,
  LABEL_MAX,
} from '../../utils/emergencyWizard.js';
import styles from './emergency.module.css';

/**
 * The setup wizard: contact -> waiting period -> what they can see -> confirm (emailed code, then Create).
 * One step per screen. The Emergency Kit screen that follows is the caller's (it must outlive this component's
 * form state, and it is the only place the kit is held).
 *
 * `replace` is true when this runs over an existing setup ("Change contact or settings"): the new setup takes the
 * old one's place, which the confirm step says plainly.
 */
function EmergencyWizard({ demoMode, ownEmail, replace = false, onCancel, onCreated }) {
  const [step, setStep] = useState('contact');
  const [form, setForm] = useState(initialWizardState);
  const [touched, setTouched] = useState(false);
  const [folders, setFolders] = useState(null);
  const [foldersError, setFoldersError] = useState('');
  const [codeOpen, setCodeOpen] = useState(false);
  const [fresh, setFresh] = useState(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const patch = (values) => setForm((current) => ({ ...current, ...values }));
  const validation = stepValidation(step, form, { demoMode, ownEmail });
  const errors = touched ? validation.errors : {};

  // The folder tree is only fetched when somebody picks "Selected folders".
  useEffect(() => {
    if (form.scopeMode !== 'folders' || folders !== null) return;
    listFolderChoices()
      .then((list) => setFolders(folderTree(list)))
      .catch((err) => setFoldersError(extractErrorMessage(err, 'Could not load your folders.')));
  }, [form.scopeMode, folders]);

  const goNext = () => {
    setTouched(true);
    if (!validation.ok) return;
    setTouched(false);
    setStep(nextStep(step));
  };

  const goBack = () => {
    setTouched(false);
    setError('');
    setStep(previousStep(step));
  };

  const create = async (codeBody) => {
    setCreating(true);
    setError('');
    try {
      const body = { ...setupBody(form), ...(replace ? { replace: true } : {}) };
      const result = await setupEmergency(body, codeBody);
      onCreated(result, { contactName: form.label.trim() });
    } catch (err) {
      // A wrong, expired or used code: ask for a new one. Anything else is shown as it is.
      setFresh(null);
      setError(
        err?.response?.status === 401
          ? 'That code didn’t work. Ask for a new one and try again.'
          : extractErrorMessage(err, 'Could not set up Emergency Access. Please try again.')
      );
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className={styles.card} aria-labelledby="wizard-title" data-testid="emergency-wizard" data-step={step}>
      <p className={styles.stepCount}>Step {stepNumber(step)} of {STEPS.length - 1}</p>
      <h2 id="wizard-title" className={styles.cardTitle}>{STEP_TITLES[step]}</h2>

      {step === 'contact' && (
        <div className={styles.stepBody}>
          <p className={styles.muted}>Choose the person you trust. Warden emails them codes; you decide how long you have to deny a request.</p>
          <div className={styles.field}>
            <label htmlFor="ea-label">Name or label (optional)</label>
            <input id="ea-label" type="text" value={form.label} maxLength={LABEL_MAX} autoComplete="off" onChange={(event) => patch({ label: event.target.value })} aria-invalid={Boolean(errors.label)} />
            {errors.label && <p className={styles.error} role="alert">{errors.label}</p>}
          </div>
          <div className={styles.field}>
            <label htmlFor="ea-email">Their email address</label>
            <input id="ea-email" type="email" value={form.email} autoComplete="off" inputMode="email" onChange={(event) => patch({ email: event.target.value })} aria-invalid={Boolean(errors.email)} />
            {errors.email && <p className={styles.error} role="alert">{errors.email}</p>}
          </div>
        </div>
      )}

      {step === 'wait' && (
        <div className={styles.stepBody}>
          <p className={styles.muted}>After your contact asks, nothing happens until this time has passed. You are emailed when your contact asks (the request is refused if that email cannot be sent), the wait is counted from that email, and you can deny it until then.</p>
          <div className={styles.choices} role="radiogroup" aria-label="Waiting period">
            {waitChoices(demoMode).map((choice) => (
              <label key={choice.minutes} className={`${styles.choice} ${form.waitMinutes === choice.minutes ? styles.choiceOn : ''}`}>
                <input type="radio" name="ea-wait" checked={form.waitMinutes === choice.minutes} onChange={() => patch({ waitMinutes: choice.minutes })} />
                <span>
                  <strong>{choice.label}</strong>
                  {choice.demo && <span className={styles.demoBadge}>Demo</span>}
                  <span className={styles.choiceDetail}>{choice.detail}</span>
                </span>
              </label>
            ))}
          </div>
          {errors.wait && <p className={styles.error} role="alert">{errors.wait}</p>}
        </div>
      )}

      {step === 'scope' && (
        <div className={styles.stepBody}>
          <p className={styles.muted}>They can only read and download. This limit is enforced by Warden’s server.</p>
          <div className={styles.choices} role="radiogroup" aria-label="What they can see">
            <label className={`${styles.choice} ${form.scopeMode === 'all' ? styles.choiceOn : ''}`}>
              <input type="radio" name="ea-scope" checked={form.scopeMode === 'all'} onChange={() => patch({ scopeMode: 'all' })} />
              <span><strong>Everything</strong><span className={styles.choiceDetail}>Every file in your vault (not Trash).</span></span>
            </label>
            <label className={`${styles.choice} ${form.scopeMode === 'folders' ? styles.choiceOn : ''}`}>
              <input type="radio" name="ea-scope" checked={form.scopeMode === 'folders'} onChange={() => patch({ scopeMode: 'folders' })} />
              <span><strong>Selected folders</strong><span className={styles.choiceDetail}>Only the folders you pick, and what is inside them.</span></span>
            </label>
          </div>
          {form.scopeMode === 'folders' && (
            <div className={styles.folderBox} data-testid="folder-picker">
              {foldersError && <p className={styles.error} role="alert">{foldersError}</p>}
              {!folders && !foldersError && <p className={styles.muted}>Loading your folders…</p>}
              {folders && folders.length === 0 && <p className={styles.muted}>You have no folders yet. Make one in My files first, or share everything.</p>}
              {folders && folders.map((folder) => (
                <label key={folder.id} className={styles.folderRow} style={{ paddingLeft: `${folder.depth * 18 + 8}px` }}>
                  <input type="checkbox" checked={form.folderIds.includes(folder.id)} onChange={() => patch({ folderIds: toggleFolder(form.folderIds, folder.id) })} />
                  <span>{folder.name}</span>
                </label>
              ))}
            </div>
          )}
          {form.scopeMode === 'folders' && <p className={styles.small}>{form.folderIds.length} selected (up to {MAX_FOLDERS}). Picking a folder includes the folders inside it.</p>}
          {errors.scope && <p className={styles.error} role="alert">{errors.scope}</p>}
        </div>
      )}

      {step === 'confirm' && (
        <div className={styles.stepBody}>
          <dl className={styles.summary}>
            {summaryLines(form, folders || []).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {replace && <p className={styles.warn} role="note">This replaces your current setup. The old kit stops working, and any open request or session ends.</p>}
          <p className={styles.small}>We’ll email you a code to confirm. Then you’ll get the Emergency Kit to give to your contact.</p>
          {error && <p className={styles.error} role="alert">{error}</p>}
          {fresh ? (
            <p className={styles.ok} role="status">Code confirmed. Ready to create.</p>
          ) : null}
        </div>
      )}

      <div className={styles.actions}>
        {step === 'contact' ? (
          <button type="button" className={styles.secondary} onClick={onCancel}>Cancel</button>
        ) : (
          <button type="button" className={styles.secondary} onClick={goBack} disabled={creating}>Back</button>
        )}
        {step !== 'confirm' && <button type="button" className={styles.primary} onClick={goNext}>Next</button>}
        {step === 'confirm' && !fresh && (
          <button type="button" className={styles.primary} onClick={() => setCodeOpen(true)} disabled={creating}>Email me a code</button>
        )}
        {step === 'confirm' && fresh && (
          <button type="button" className={styles.primary} onClick={() => create(fresh)} disabled={creating}>
            {creating ? 'Creating…' : replace ? 'Replace setup' : 'Create'}
          </button>
        )}
      </div>

      {codeOpen && (
        <FreshCodeDialog
          action="setup"
          title="Confirm with a code"
          intro="Setting up Emergency Access needs a fresh code from your email."
          onClose={() => setCodeOpen(false)}
          onVerified={(result) => {
            setCodeOpen(false);
            setFresh(result);
          }}
        />
      )}
    </section>
  );
}

export default EmergencyWizard;
