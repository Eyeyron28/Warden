import { useEffect } from 'react';

const DEFAULT_DESCRIPTION =
  'Warden keeps your IDs, contracts and records encrypted with a key that is stored locked by your password and your recovery key.';

function setMeta(selector, attribute, value) {
  const element = document.head.querySelector(selector);
  if (element) element.setAttribute(attribute, value);
}

/**
 * Per-route <title> and meta description (plus the matching Open Graph
 * fields) for the public pages.
 */
export function usePageMeta(title, description = DEFAULT_DESCRIPTION) {
  useEffect(() => {
    const fullTitle = title ? `${title} - Warden` : 'Warden - Encrypted document vault';
    document.title = fullTitle;
    setMeta('meta[name="description"]', 'content', description);
    setMeta('meta[property="og:title"]', 'content', fullTitle);
    setMeta('meta[property="og:description"]', 'content', description);
  }, [title, description]);
}
