/**
 * The server's two upload limits (per account): too many uploads too fast (429 UPLOAD_RATE_LIMITED, with Retry-After) and too many
 * documents (409 DOCUMENT_LIMIT). Only the lazy upload code (services/transferRuntime.js, utils/zipImport.js) imports this, so the
 * wording does not weigh on the first page.
 */
export const RATE_LIMITED = 'UPLOAD_RATE_LIMITED';
export const DOCUMENT_LIMIT = 'DOCUMENT_LIMIT';

/** 'UPLOAD_RATE_LIMITED' | 'DOCUMENT_LIMIT' | null for a failed upload request. */
export function limitCodeOf(error) {
  const code = error?.response?.data?.error?.code;
  return code === RATE_LIMITED || code === DOCUMENT_LIMIT ? code : null;
}

/** Seconds until another upload may be tried: the Retry-After header, else the body's retryAfterSeconds, else a minute. */
export function retrySeconds(error) {
  const header = Number(error?.response?.headers?.['retry-after']);
  const body = Number(error?.response?.data?.error?.retryAfterSeconds);
  const seconds = Number.isFinite(header) && header > 0 ? header : Number.isFinite(body) && body > 0 ? body : 60;
  return Math.ceil(seconds);
}

/** "Too many uploads at once. Try again in 3 minutes." / the server's sentence for the document cap (no trailing full stop kept). */
export function limitMessage(code, { seconds = 60, message = '' } = {}) {
  if (code === DOCUMENT_LIMIT) return String(message || 'You have reached the limit of files. Delete some files or empty the Trash.').replace(/\s+$/, '');
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Too many uploads at once. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

/**
 * The tray row's error for a limit: "Not saved" with the sentence; Retry only for the speed limit (a full account is fixed by deleting
 * files, not by waiting). `limit` lets the transfers manager mark the rest of the batch the same way without sending it.
 */
export const limitedError = (code, seconds, message) => ({
  message: limitMessage(code, { seconds, message }),
  code: code === RATE_LIMITED ? 'rate-limit' : 'document-limit',
  retryable: code === RATE_LIMITED,
  notSaved: true,
  limit: { code, message: message || '' },
  seconds,
});
