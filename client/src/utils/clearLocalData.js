import { clearToken } from '../services/session.js';

/**
 * After an account is deleted: let go of everything this tab holds for it.
 *
 *   - the in-memory session token (which also empties the decrypted thumbnail
 *     cache, via its subscription in services/thumbnailCache.js);
 *   - this browser's own offline copy, if it was ever paired as a phone: the
 *     IndexedDB database the phone vault uses (services/localVault.js).
 *
 * It cannot reach OTHER devices: a phone that was paired keeps its own
 * offline copy until that phone's browser data is cleared.
 */
const LOCAL_VAULT_DB = 'warden-local';

/** Removes this browser's offline copy (see above). Never throws. */
export async function clearOfflineCopy() {
  try {
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(LOCAL_VAULT_DB);
      request.onsuccess = resolve;
      request.onerror = resolve;
      request.onblocked = resolve; // another tab holds it open; it goes when that tab closes
    });
  } catch {
    // IndexedDB can be unavailable (private mode); nothing more to clear.
  }
}

/** Everything this tab holds for the account. */
export async function clearLocalData() {
  clearToken();
  await clearOfflineCopy();
}
