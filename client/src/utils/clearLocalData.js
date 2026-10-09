import { clearToken } from '../services/session.js';

/**
 * After an account is deleted: let go of everything this tab holds for it - the session token (kept in
 * sessionStorage so a reload stays signed in) and, through its subscription in services/thumbnailCache.js,
 * the decrypted thumbnails. Warden is a website: nothing else is stored on this device.
 */
export function clearLocalData() {
  clearToken();
}
