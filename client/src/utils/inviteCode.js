export const INVITE_MAX_LENGTH = 256;

export const INVITE_REQUIRED_MESSAGE = 'Enter your invite code.';
export const INVITE_REJECTED_MESSAGE = 'The invite code is missing or incorrect.';

export function cleanInviteCode(value) {
  return String(value ?? '').trim();
}

export function inviteFieldError(value) {
  const code = cleanInviteCode(value);
  if (!code) return INVITE_REQUIRED_MESSAGE;
  if (code.length > INVITE_MAX_LENGTH) return `An invite code is at most ${INVITE_MAX_LENGTH} characters.`;
  return '';
}

export function formatRetry(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return 'a little while';
  if (s < 90) return `${Math.ceil(s)} second${Math.ceil(s) === 1 ? '' : 's'}`;
  const minutes = Math.ceil(s / 60);
  if (minutes < 90) return `about ${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return `about ${hours} hour${hours === 1 ? '' : 's'}`;
}

export function describeSignupFailure(error, fallback = 'We couldn’t create your vault. Please try again.') {
  const status = error?.response?.status;
  const body = error?.response?.data?.error;
  if (body?.code === 'INVITE_CODE_INVALID') {
    return { kind: 'invite', message: INVITE_REJECTED_MESSAGE };
  }
  if (status === 429) {
    const retryAfterSeconds = Number(body?.retryAfterSeconds) || 0;
    return {
      kind: 'rate',
      retryAfterSeconds,
      message: `Too many attempts. Please try again in ${formatRetry(retryAfterSeconds)}.`,
    };
  }
  if (body?.code === 'EMAIL_DOMAIN_NO_MAIL') {
    return { kind: 'email', message: body.message };
  }
  if (status === 400 && Array.isArray(body?.errors)) {
    return { kind: 'password', message: body.errors.join(' ') };
  }
  return { kind: 'other', message: body?.message || fallback };
}
