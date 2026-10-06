import { useSyncExternalStore } from 'react';

import { getToken, subscribeToken } from '../services/session.js';

/**
 * The current in-memory session token (or null), re-rendering whenever it
 * changes - login, logout, or the axios 401 interceptor clearing it.
 */
export function useSessionToken() {
  return useSyncExternalStore(subscribeToken, getToken);
}
