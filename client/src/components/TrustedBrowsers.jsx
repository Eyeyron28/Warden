import { useCallback, useEffect, useState } from 'react';

import Icon from './site/Icon.jsx';
import { listTrustedDevices, removeAllTrustedDevices, removeTrustedDevice } from '../services/accountService.js';
import { extractErrorMessage } from '../services/api.js';
import { formatDateTime } from '../utils/formatDate.js';
import site from './site/site.module.css';
import forms from './site/forms.module.css';
import styles from '../pages/auth/auth.module.css';

/**
 * The browsers that skip the emailed code at login (ticked "Trust this browser
 * for 30 days"). They never skip the password. Removing one - or all - means
 * the next login there asks for a code again.
 */
function TrustedBrowsers() {
  const [devices, setDevices] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDevices((await listTrustedDevices()).devices);
      setError('');
    } catch (err) {
      setError(extractErrorMessage(err, 'We couldn’t load your trusted browsers.'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (action) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      await load();
    } catch (err) {
      setError(extractErrorMessage(err, 'That didn’t work. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.trusted} aria-labelledby="trusted-title">
      <h2 id="trusted-title" style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="shield" size={18} />
        Trusted browsers
      </h2>
      <p className={styles.dangerBody}>
        A trusted browser skips the emailed code when you log in. It still asks for your password every time. Remove
        one and the next login there asks for a code again.
      </p>

      {error && (
        <div className={forms.alert} role="alert" style={{ marginTop: 12 }}>
          <Icon name="alert" />
          <p>{error}</p>
        </div>
      )}

      {devices && devices.length === 0 && <p className={styles.dangerBody}>No browsers are trusted.</p>}

      {devices && devices.length > 0 && (
        <>
          <ul className={styles.trustedList}>
            {devices.map((device) => (
              <li key={device.id} className={styles.trustedItem}>
                <div className={styles.trustedInfo}>
                  <div className={styles.trustedName}>
                    {device.label}
                    {device.current ? ' (this browser)' : ''}
                  </div>
                  <div>Added {formatDateTime(device.createdAt)}</div>
                  <div>Last used {formatDateTime(device.lastUsedAt)}</div>
                </div>
                <button
                  type="button"
                  className={`${site.button} ${site.ghost}`}
                  disabled={busy}
                  onClick={() => run(() => removeTrustedDevice(device.id))}
                  aria-label={`Remove ${device.label}${device.current ? ' (this browser)' : ''}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          {devices.length > 1 && (
            <button
              type="button"
              className={`${site.button} ${site.ghost}`}
              style={{ marginTop: 16 }}
              disabled={busy}
              onClick={() => run(removeAllTrustedDevices)}
            >
              Remove all
            </button>
          )}
        </>
      )}
    </section>
  );
}

export default TrustedBrowsers;
