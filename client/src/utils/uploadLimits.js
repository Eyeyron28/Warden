export const RATE_LIMITED = 'UPLOAD_RATE_LIMITED';
export const DOCUMENT_LIMIT = 'DOCUMENT_LIMIT';

export function limitCodeOf(error) {
  const code = error?.response?.data?.error?.code;
  return code === RATE_LIMITED || code === DOCUMENT_LIMIT ? code : null;
}

export function retrySeconds(error) {
  const header = Number(error?.response?.headers?.['retry-after']);
  const body = Number(error?.response?.data?.error?.retryAfterSeconds);
  const seconds = Number.isFinite(header) && header > 0 ? header : Number.isFinite(body) && body > 0 ? body : 60;
  return Math.ceil(seconds);
}

export function limitMessage(code, { seconds = 60, message = '' } = {}) {
  if (code === DOCUMENT_LIMIT) return String(message || 'You have reached the limit of files. Delete some files or empty the Trash.').replace(/\s+$/, '');
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Too many uploads at once. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

export const limitedError = (code, seconds, message) => ({
  message: limitMessage(code, { seconds, message }),
  code: code === RATE_LIMITED ? 'rate-limit' : 'document-limit',
  retryable: code === RATE_LIMITED,
  notSaved: true,
  limit: { code, message: message || '' },
  seconds,
});
