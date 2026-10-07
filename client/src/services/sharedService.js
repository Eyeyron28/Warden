import axios from 'axios';

// Deliberately NOT the shared services/api.js instance: this is the public,
// signed-out side of a share. That instance attaches the session token and
// clears it on a 401, neither of which has any business here.
const publicApi = axios.create({ baseURL: '/api' });

const base = (shareId) => `/shared/${encodeURIComponent(shareId)}`;
// The visitor's access token travels in a header, never in a URL.
const withAccess = (accessToken, extra = {}) => ({
  ...extra,
  headers: accessToken ? { 'X-Share-Access': accessToken } : undefined,
});

/**
 * POST /api/shared/:shareId/access
 * Opens a visit and says which gates the link has. For a password share it also
 * returns the public salt and scrypt cost the browser needs to derive the
 * verifier. The backend returns the exact same generic 404 for every failure
 * (never existed, expired, revoked, download limit used up), so this rejects
 * with whatever axios throws.
 * @returns {Promise<{ accessToken: string, needsEmail: boolean, maskedEmail: string|null, needsPassword: boolean, password: { salt: string, kdf: { N: number, r: number, p: number } }|null, limited: boolean }>}
 */
export async function openAccess(shareId) {
  const { data } = await publicApi.post(`${base(shareId)}/access`);
  return data;
}

/**
 * POST /api/shared/:shareId/email-code - emails the recipient a 6-digit code
 * (the first call) or sends a new one (a resend). 429 carries retryAfterSeconds
 * inside the cooldown.
 * @returns {Promise<{ sent: boolean, expiresAt: string, resendAvailableAt: string, resendsLeft: number }>}
 */
export async function requestEmailCode(shareId, accessToken) {
  const { data } = await publicApi.post(`${base(shareId)}/email-code`, {}, withAccess(accessToken));
  return data;
}

/** POST /api/shared/:shareId/email-verify - the right code passes the email gate, once. */
export async function verifyEmailCode(shareId, accessToken, code) {
  const { data } = await publicApi.post(`${base(shareId)}/email-verify`, { code }, withAccess(accessToken));
  return data;
}

/**
 * POST /api/shared/:shareId/unlock - sends the verifier (derived from the
 * password in the browser; never the password). A correct one returns the
 * WRAPPED share key, which still needs the password to open.
 * @returns {Promise<{ salt: string, kdf: object, wrappedKey: string }>}
 */
export async function unlockShare(shareId, accessToken, verifier) {
  const { data } = await publicApi.post(`${base(shareId)}/unlock`, { verifier }, withAccess(accessToken));
  return data;
}

/**
 * GET /api/shared/:shareId
 * Returns only ciphertext: the encrypted manifest (base64 of iv || ciphertext
 * || tag) and the id and size of each encrypted file. The key to open any of it
 * is in the link's #fragment (or wrapped under the password) and is never sent here.
 * @returns {Promise<{ expiresAt: string, manifest: string, files: Array<{ id: string, size: number }> }>}
 */
export async function fetchSharedManifest(shareId, accessToken) {
  const { data } = await publicApi.get(base(shareId), withAccess(accessToken));
  return data;
}

/**
 * GET /api/shared/:shareId/files/:fileId - one encrypted file as raw bytes
 * (iv || ciphertext || tag). Decryption happens in the browser. Counts as one
 * download against the share's limit, if it has one.
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchSharedFile(shareId, fileId, accessToken) {
  const { data } = await publicApi.get(
    `${base(shareId)}/files/${encodeURIComponent(fileId)}`,
    withAccess(accessToken, { responseType: 'arraybuffer' })
  );
  return data;
}
