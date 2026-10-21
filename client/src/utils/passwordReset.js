import { formatRetry } from './inviteCode.js';

const KEY_CHARS = /^[A-HJ-NP-Z2-9]$/;

export function formatRecoveryKeyInput(raw) {
  const compact = String(raw ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 16);
  return compact.match(/.{1,4}/g)?.join('-') ?? '';
}

export function recoveryKeyProblem(value) {
  const compact = String(value ?? '').replace(/[\s-]+/g, '').toUpperCase();
  if (compact.length === 0) return 'Enter your recovery key.';
  if ([...compact].some((char) => !KEY_CHARS.test(char))) {
    return 'A recovery key never contains the letters O, I or L, or the digits 0 or 1. Check what you typed.';
  }
  if (compact.length < 16) return 'A recovery key has 16 characters (four groups of four).';
  if (compact.length > 16) return 'That is too long for a recovery key (16 characters).';
  return '';
}

export const STEPS = { email: 1, code: 2, choose: 3, keep: 3, wipeWarn: 3, wipeForm: 3, newKey: 3 };

export function backStep(step) {
  switch (step) {
    case 'code':
    case 'keyOnly':
      return 'email';
    case 'choose':
      return 'email';
    case 'keep':
    case 'wipeWarn':
      return 'choose';
    case 'wipeForm':
      return 'wipeWarn';
    default:
      return null;
  }
}

export function describeResetFailure(error, fallback = 'We couldn’t reset your password. Please try again.') {
  const status = error?.response?.status;
  const body = error?.response?.data?.error;
  if (body?.code === 'RESET_TICKET_INVALID') {
    return { kind: 'ticket', message: 'That reset session ended (it expired, was already used, or had too many wrong keys). Start again to get a new code.' };
  }
  if (status === 429) {
    const seconds = Number(body?.retryAfterSeconds) || 0;
    return { kind: 'rate', message: `Too many attempts. Please try again in ${formatRetry(seconds)}.` };
  }
  if (status === 401) return { kind: 'key', message: body?.message || 'That recovery key is incorrect.' };
  if (status === 400 && Array.isArray(body?.errors)) return { kind: 'policy', message: body.errors.join(' ') };
  if (status === 400 && /does not match/i.test(body?.message || '')) return { kind: 'mismatch', message: body.message };
  return { kind: 'other', message: body?.message || fallback };
}
