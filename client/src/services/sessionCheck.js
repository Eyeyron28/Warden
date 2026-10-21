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
