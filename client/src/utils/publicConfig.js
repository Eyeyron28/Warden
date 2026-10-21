import { useCallback, useEffect, useState } from 'react';

import { getPublicConfig } from '../services/authService.js';

let cached = null;

export function useSignupConfig() {
  const [state, setState] = useState(() => (cached ? { status: 'ready', config: cached } : { status: 'loading', config: null }));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (cached) return undefined;
    let cancelled = false;
    setState({ status: 'loading', config: null });
    getPublicConfig()
      .then((config) => {
        if (config?.signupMode !== 'open' && config?.signupMode !== 'invite') throw new Error('Unexpected sign-up settings.');
        cached = config;
        if (!cancelled) setState({ status: 'ready', config });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', config: null });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}

export function resetPublicConfigCache() {
  cached = null;
}
