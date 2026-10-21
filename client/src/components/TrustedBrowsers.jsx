import { lazy, Suspense, useCallback, useEffect, useState } from 'react';

import Icon from './site/Icon.jsx';
import { listTrustedDevices, removeAllTrustedDevices, removeTrustedDevice } from '../services/accountService.js';
import { extractErrorMessage } from '../services/api.js';
import { formatDateTime } from '../utils/formatDate.js';
import { currentFirst, hasOverflow, inlineDevices } from '../utils/trustedBrowsers.js';
import site from './site/site.module.css';
import forms from './site/forms.module.css';
import styles from '../pages/auth/auth.module.css';

const Modal = lazy(() => import('./Modal.jsx'));

function TrustedBrowsers() {
  const [devices, setDevices] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);

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

  const overflowing = devices ? hasOverflow(devices) : false;

  useEffect(() => {
    if (devices && !hasOverflow(devices)) setShowAll(false);
  }, [devices]);

  const renderRow = (device) => (
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
  );

  const removeAll = (
    <button type="button" className={`${site.button} ${site.ghost}`} disabled={busy} onClick={() => run(removeAllTrustedDevices)}>
      Remove all
    </button>
  );

  return (
    <section className={styles.trusted} aria-labelledby="trusted-title">
      <h2
        id="trusted-title"
        style={{
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <Icon name="shield" size={18} />
        Trusted browsers
      </h2>
      <p className={styles.dangerBody}>
        A trusted browser skips the emailed code when you log in. It still asks for your password every time. Remove one and the next login
        there asks for a code again.
      </p>

      {error && (
        <div className={forms.alert} role="alert" style={{ marginTop: 12 }}>
          <Icon name="alert" />
          <p>{error}</p>
        </div>
      )}

      {devices && devices.length === 0 && <p className={styles.dangerBody}>No trusted browsers yet.</p>}

      {devices && devices.length > 0 && (
        <>
          <ul className={styles.trustedList}>{inlineDevices(devices).map(renderRow)}</ul>
          {(overflowing || devices.length > 1) && (
            <div className={styles.trustedActions}>
              {overflowing && (
                <button type="button" className={`${site.button} ${site.ghost}`} onClick={() => setShowAll(true)}>
                  View all devices ({devices.length})
                </button>
              )}
              {devices.length > 1 && removeAll}
            </div>
          )}
        </>
      )}

      {showAll && devices && overflowing && (
        <Suspense fallback={null}>
          <Modal title="Trusted browsers" onClose={() => setShowAll(false)} footer={removeAll}>
            {error && (
              <div className={forms.alert} role="alert">
                <Icon name="alert" />
                <p>{error}</p>
              </div>
            )}
            <ul className={styles.trustedList} style={{ marginTop: 0 }}>
              {currentFirst(devices).map(renderRow)}
            </ul>
          </Modal>
        </Suspense>
      )}
    </section>
  );
}

export default TrustedBrowsers;
