import { useEffect, useRef, useState } from 'react';

import styles from './UpdatePrompt.module.css';

function UpdatePrompt() {
  const [ready, setReady] = useState(false);
  const bar = useRef(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;
    const hadController = Boolean(navigator.serviceWorker.controller);
    const onChange = () => {
      if (hadController) setReady(true);
    };
    navigator.serviceWorker.addEventListener('controllerchange', onChange);

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

  useEffect(() => {
    if (!ready) return undefined;
    document.documentElement.classList.add('update-bar-open');
    return () => document.documentElement.classList.remove('update-bar-open');
  }, [ready]);

  useEffect(() => {
    if (!ready || !bar.current) return undefined;
    const root = document.documentElement;
    const publish = () => root.style.setProperty('--update-bar-h', `${Math.ceil(bar.current?.getBoundingClientRect().height ?? 0)}px`);
    publish();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish);
    observer?.observe(bar.current);
    return () => {
      observer?.disconnect();
      root.style.removeProperty('--update-bar-h');
    };
  }, [ready]);

  if (!ready) return null;
  return (
    <div className={styles.bar} role="status" ref={bar}>
      <span>A new version of Warden is available.</span>
      <button type="button" className={styles.button} onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}

export default UpdatePrompt;
