/**
 * The Emergency Access setup wizard, as plain functions (the screens in components/EmergencyWizard.jsx only draw
 * what these decide). One step per screen:
 *
 *   contact -> wait -> scope -> confirm -> kit
 *
 * Nothing here touches the network or any storage.
 */

export const STEPS = Object.freeze(['contact', 'wait', 'scope', 'confirm', 'kit']);
export const STEP_TITLES = Object.freeze({
  contact: 'Who can ask?',
  wait: 'Waiting period',
  scope: 'What they can see',
  confirm: 'Confirm',
  kit: 'Emergency Kit',
});

export const LABEL_MAX = 60;
export const MAX_FOLDERS = 50;

const DAY_CHOICES = Object.freeze([
  { minutes: 4320, label: '3 days', detail: 'The quickest option: you have 3 days to deny a request.' },
  { minutes: 10080, label: '7 days', detail: 'A week to notice and deny a request.' },
  { minutes: 20160, label: '14 days', detail: 'The longest: two weeks to deny a request.' },
]);
export const DEMO_CHOICE = Object.freeze({ minutes: 2, label: '2 minutes (demo)', detail: 'For demonstrations only. Not a real safeguard.', demo: true });

/** The waits to offer. The 2-minute demo option exists ONLY when the server says demo mode is on. */
export function waitChoices(demoMode) {
  return demoMode === true ? [DEMO_CHOICE, ...DAY_CHOICES] : [...DAY_CHOICES];
}

/** "4320" -> "3 days"; 2 -> "2 minutes"; other numbers in days/hours. */
export function describeWait(minutes) {
  if (minutes === DEMO_CHOICE.minutes) return '2 minutes (demo)';
  const choice = DAY_CHOICES.find((entry) => entry.minutes === minutes);
  if (choice) return choice.label;
  if (minutes % 1440 === 0) return `${minutes / 1440} days`;
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

const EMAIL_RE = /^[^\s@,;<>()[\]"]+@[^\s@,;<>()[\]"]+\.[^\s@,;<>()[\]"]+$/;

/** The contact's name (optional label, at most 60 characters) and email (one address, not your own). */
export function validateContact({ label = '', email = '' } = {}, ownEmail = '') {
  const errors = {};
  if ([...String(label).trim()].length > LABEL_MAX) errors.label = `Use ${LABEL_MAX} characters or fewer.`;
  const address = String(email).trim();
  if (!address) errors.email = 'Enter your contact’s email address.';
  else if (!EMAIL_RE.test(address)) errors.email = 'That doesn’t look like one email address.';
  else if (ownEmail && address.toLowerCase() === String(ownEmail).trim().toLowerCase()) errors.email = 'Your contact must be someone other than you.';
  return { ok: Object.keys(errors).length === 0, errors };
}

export function validateWait(minutes, demoMode) {
  const allowed = waitChoices(demoMode).some((choice) => choice.minutes === minutes);
  return { ok: allowed, errors: allowed ? {} : { wait: 'Choose how long you want to be able to deny a request.' } };
}

export function validateScope({ mode, folderIds = [] } = {}) {
  if (mode === 'all') return { ok: true, errors: {} };
  if (mode !== 'folders') return { ok: false, errors: { scope: 'Choose what your contact may see.' } };
  if (folderIds.length === 0) return { ok: false, errors: { scope: 'Pick at least one folder.' } };
  if (folderIds.length > MAX_FOLDERS) return { ok: false, errors: { scope: `Pick at most ${MAX_FOLDERS} folders.` } };
  return { ok: true, errors: {} };
}

export const initialWizardState = () => ({ label: '', email: '', waitMinutes: null, scopeMode: null, folderIds: [] });

/** Whether the screen for `step` may be left with Next. (The confirm step has its own Create flow.) */
export function stepValidation(step, state, { demoMode = false, ownEmail = '' } = {}) {
  if (step === 'contact') return validateContact({ label: state.label, email: state.email }, ownEmail);
  if (step === 'wait') return validateWait(state.waitMinutes, demoMode);
  if (step === 'scope') return validateScope({ mode: state.scopeMode, folderIds: state.folderIds });
  return { ok: true, errors: {} };
}

export const nextStep = (step) => STEPS[Math.min(STEPS.indexOf(step) + 1, STEPS.length - 1)];
export const previousStep = (step) => STEPS[Math.max(STEPS.indexOf(step) - 1, 0)];
export const stepNumber = (step) => STEPS.indexOf(step) + 1;

/** Adds or removes one folder id (a new array each time). */
export function toggleFolder(folderIds, id) {
  return folderIds.includes(id) ? folderIds.filter((entry) => entry !== id) : [...folderIds, id];
}

/** The body of POST /api/emergency/setup, from the wizard's state (the code fields are added by the caller). */
export function setupBody(state) {
  return {
    contactEmail: state.email.trim(),
    contactLabel: state.label.trim(),
    waitMinutes: state.waitMinutes,
    scope: state.scopeMode === 'all' ? { mode: 'all' } : { mode: 'folders', folderIds: [...state.folderIds] },
  };
}

/** The lines of the confirm screen. */
export function summaryLines(state, folderChoices = []) {
  const byId = new Map(folderChoices.map((folder) => [folder.id, folder.path]));
  const names = state.folderIds.map((id) => byId.get(id)).filter(Boolean);
  return [
    ['Your contact', state.label.trim() ? `${state.label.trim()} <${state.email.trim()}>` : state.email.trim()],
    ['Waiting period', describeWait(state.waitMinutes)],
    ['They can see', state.scopeMode === 'all' ? 'Everything in your vault' : names.length ? `${names.length} folder${names.length === 1 ? '' : 's'}: ${names.join(', ')}` : 'Selected folders'],
    ['What they can do', 'Read and download only. They cannot change, delete or share anything.'],
  ];
}

/** The Emergency Kit screen cannot be closed until the owner confirms they have saved or printed it. */
export const KIT_ACK_TEXT = 'I’ve saved or printed the kit. I understand it cannot be shown again.';
export const canLeaveKitScreen = ({ acknowledged }) => acknowledged === true;

/** A folder list sorted for a tree: each entry with its depth (number of slashes). */
export function folderTree(folderChoices) {
  return [...folderChoices]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((folder) => ({ ...folder, depth: folder.path.split('/').length - 1, name: folder.path.split('/').pop() }));
}
