/**
 * What survives a reload in the middle of sign-up: the EMAIL ADDRESS, so the person does not retype it. Nothing else - never
 * the password, the invite code, the code from the email or the recovery key. It lives in sessionStorage (this tab only),
 * is cleared once sign-up finishes, and every access is guarded because storage can be blocked.
 */

const KEY = 'warden.signup.email';
const EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

export function readSignupEmail(storage = typeof window === 'undefined' ? null : window.sessionStorage) {
  try {
    const value = storage?.getItem(KEY);
    return typeof value === 'string' && EMAIL_SHAPE.test(value) ? value : '';
  } catch {
    return '';
  }
}

export function saveSignupEmail(email, storage = typeof window === 'undefined' ? null : window.sessionStorage) {
  try {
    if (EMAIL_SHAPE.test(String(email ?? '').trim())) storage?.setItem(KEY, String(email).trim());
  } catch {
    // nothing more to do
  }
}

export function clearSignupEmail(storage = typeof window === 'undefined' ? null : window.sessionStorage) {
  try {
    storage?.removeItem(KEY);
  } catch {
    // nothing more to do
  }
}

/**
 * The state the sign-up page starts in. A reload always returns to the form (step 1): the email is filled in again, nothing
 * secret is.
 */
export function initialSignupState(storage) {
  return { step: 'form', values: { email: readSignupEmail(storage), password: '', confirm: '', invite: '' } };
}

/** The sign-up steps, in order: the form -> the code -> the recovery key -> the app. */
export const SIGNUP_STEPS = Object.freeze(['form', 'code', 'key']);

/** Moves between steps. Going back from the code step returns to the form; nothing else goes backwards. */
export function nextStep(step, event) {
  if (step === 'form' && event === 'codeSent') return 'code';
  if (step === 'code' && event === 'verified') return 'key';
  if (step === 'code' && event === 'back') return 'form';
  if (step === 'code' && event === 'expired') return 'form';
  if (step === 'key' && event === 'continue') return 'done';
  return step;
}
