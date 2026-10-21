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
  }
}

export function clearSignupEmail(storage = typeof window === 'undefined' ? null : window.sessionStorage) {
  try {
    storage?.removeItem(KEY);
  } catch {
  }
}

export function initialSignupState(storage) {
  return { step: 'form', values: { email: readSignupEmail(storage), password: '', confirm: '', invite: '' } };
}

export const SIGNUP_STEPS = Object.freeze(['form', 'code', 'key']);

export function nextStep(step, event) {
  if (step === 'form' && event === 'codeSent') return 'code';
  if (step === 'code' && event === 'verified') return 'key';
  if (step === 'code' && event === 'back') return 'form';
  if (step === 'code' && event === 'expired') return 'form';
  if (step === 'key' && event === 'continue') return 'done';
  return step;
}
