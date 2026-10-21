import { useSyncExternalStore } from 'react';

import { getToken, subscribeToken } from '../services/session.js';

export function useSessionToken() {
  return useSyncExternalStore(subscribeToken, getToken);
}
