/**
 * What happens to a session token the page finds when it starts (kept in sessionStorage across a reload, or
 * handed over by another open tab): prove it with the server before the signed-in screens render.
 *
 *   - no token anywhere            -> nothing to do (the guard sends the visitor to the login page);
 *   - the server accepts it        -> signed in, nothing visible happens;
 *   - the server says 401          -> the session is over (expired, or signed out from another device): the token
 *                                     is cleared and the login page says "Your session expired. Sign in again.";
 *   - the server cannot be reached -> the token is KEPT: a dead connection is not a dead session.
 *
 * @param {{
 *   getToken: () => string | null,
 *   adoptFromOtherTabs: () => Promise<string | null>,
 *   verify: () => Promise<unknown>,
 *   expire: () => void,
 * }} deps
 * @returns {Promise<'none' | 'valid' | 'expired' | 'unverified'>}
 */
export async function checkStoredSession({ getToken, adoptFromOtherTabs, verify, expire }) {
  const token = getToken() || (await adoptFromOtherTabs());
  if (!token) return 'none';
  try {
    await verify();
    return 'valid';
  } catch (error) {
    if (error?.response?.status === 401) {
      expire();
      return 'expired';
    }
    return 'unverified';
  }
}
