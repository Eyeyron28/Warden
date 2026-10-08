import { useCallback, useEffect, useState } from 'react';

import { getPublicConfig } from '../services/authService.js';

// A successful answer is kept for the life of the page (the sign-up page and the
// landing page both ask). A failure is never kept, so "Try again" really asks again.
let cached = null;

/**
 * GET /api/auth/config for the pages that depend on it.
 * status: 'loading' | 'ready' | 'error' - never a guess: when the answer is not
 * known, `config` is null and the page shows a retry state instead of a form that
 * might be missing the invite field.
 *
 * @returns {{ status: 'loading' | 'ready' | 'error', config: { signupMode: 'open' | 'invite', requestAccessText?: string } | null, retry: () => void }}
 */
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

/** For tests: forget the kept answer. */
export function resetPublicConfigCache() {
  cached = null;
}
