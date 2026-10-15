import { useEffect, useState } from 'react';

import styles from './UpdatePrompt.module.css';

/**
 * "New version available" bar. The service worker takes over as soon as a new
 * deployment is live (skipWaiting + clients.claim); this tab is still running
 * the old code until it reloads, so it says so and lets the person choose
 * when, rather than reloading under a half-typed form.
 *
 * A first install also fires controllerchange, so the bar only shows when the
 * page already had a controller, i.e. this really is a replacement.
 */
function UpdatePrompt() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;
    const hadController = Boolean(navigator.serviceWorker.controller);
    const onChange = () => {
      if (hadController) setReady(true);
    };
    navigator.serviceWorker.addEventListener('controllerchange', onChange);

    // Look for a newer deployment now and whenever the tab comes back.
    const check = () => navigator.serviceWorker.getRegistration().then((registration) => registration?.update()).catch(() => {});
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onChange);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // While the bar is up, the page gets room at its bottom (styles/global.css) so the footer and any bottom bar can scroll above it.
  useEffect(() => {
    if (!ready) return undefined;
    document.documentElement.classList.add('update-bar-open');
    return () => document.documentElement.classList.remove('update-bar-open');
  }, [ready]);

  if (!ready) return null;
  return (
    <div className={styles.bar} role="status">
      <span>A new version of Warden is available.</span>
      <button type="button" className={styles.button} onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}

export default UpdatePrompt;
