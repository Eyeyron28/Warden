import { uploadFitsMessage } from './storageUsage.js';
import { formatBytes } from './listing.js';

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_NAME_CHARS = 255;

export function validateUpload(file, { usage = null, pendingBytes = 0 } = {}) {
  const name = String(file?.name ?? '').trim();
  if (!name) return { ok: false, reason: 'This file has no name.', code: 'name' };
  if ([...name].length > MAX_NAME_CHARS) return { ok: false, reason: `The name is longer than ${MAX_NAME_CHARS} characters.`, code: 'name' };
  if (file.size > MAX_FILE_BYTES) return { ok: false, reason: `${name} is ${formatBytes(file.size)}. A file can be at most 4 MB.`, code: 'size' };
  const full = uploadFitsMessage(usage, file.size + pendingBytes);
  if (full) return { ok: false, reason: full, code: 'quota' };
  return { ok: true };
}

export function describeTransferError(error) {
  if (error?.described) return error.described;
  const status = error?.response?.status;
  const code = error?.response?.data?.error?.code;
  const message = String(error?.response?.data?.error?.message || '');
  if (code === 'STORAGE_QUOTA' || /storage is full|not enough storage/i.test(message)) {
    const limit = /your (\d+) MB/i.exec(message)?.[1];
    return { message: limit ? `Over your ${limit} MB limit` : 'Over your storage limit', code: 'quota', retryable: false };
  }
  if (status === 413) return { message: 'Over the 4 MB file limit', code: 'size', retryable: false };
  if (!error?.response) return { message: 'Network error', code: 'network', retryable: true };
  if (status === 409) return { message: message || 'Not saved: it conflicts with a file already there', code: 'conflict', retryable: false };
  if (status === 429) return { message: 'Too many uploads. Try again in a moment', code: 'rate', retryable: true };
  if (status >= 500) return { message: 'The server had a problem', code: 'server', retryable: true };
  return { message: message.slice(0, 80) || 'Could not be uploaded', code: 'other', retryable: status !== 400 && status !== 404 };
}
