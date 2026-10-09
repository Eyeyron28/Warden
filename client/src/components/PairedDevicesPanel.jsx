import { useCallback, useEffect, useState } from 'react';

import { listDevices, revokeDevice } from '../services/devicesService.js';
import { extractErrorMessage } from '../services/api.js';
import { formatDateTime } from '../utils/formatDate.js';
import styles from '../pages/DevicesPage.module.css';

/**
 * Every phone paired with this account: name, browser, when it paired, when it
 * last synced, and whether it is still allowed to. Removing one takes away its
 * sync token at once (the phone's next request is refused). What it cannot take
 * back is the encrypted copy the phone already holds, and the dialog says so.
 *
 * `reloadKey` changes when a new phone has just paired, to refresh the list.
 */
function PairedDevicesPanel({ reloadKey = 0 }) {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirmingId, setConfirmingId] = useState(null);
  const [revokingId, setRevokingId] = useState(null);

  const refresh = useCallback(async () => {
    setError('');
    try {
      setDevices(await listDevices());
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not load your devices.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, reloadKey]);

  const handleRevoke = async (id) => {
    setRevokingId(id);
    setError('');
    try {
      await revokeDevice(id);
      setConfirmingId(null);
      await refresh();
    } catch (err) {
      // A 404 means it is already gone (removed elsewhere): show the list as it is now.
      if (err?.response?.status === 404) {
        setConfirmingId(null);
        await refresh();
      } else {
        setError(extractErrorMessage(err, 'Could not remove this device.'));
      }
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div className={styles.pairBody}>
      {loading && <p className={styles.small}>Loading…</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {!loading && !error && devices.length === 0 && <p className={styles.text}>No phone is paired yet.</p>}

      {devices.length > 0 && (
        <ul className={styles.list}>
          {devices.map((device) => {
            const name = device.deviceName || 'Unnamed device';
            return (
              <li key={device.id} className={styles.device}>
                <div className={styles.meta}>
                  <span className={styles.deviceName}>
                    {name}
                    <span className={`${styles.badge} ${device.revoked ? '' : styles.badgeActive}`}>{device.revoked ? 'Removed' : 'Active'}</span>
                  </span>
                  <span className={styles.sub}>
                    {device.browserLabel ? `${device.browserLabel} · ` : ''}Paired {formatDateTime(device.pairedAt)}
                  </span>
                  <span className={styles.sub}>
                    {device.revoked
                      ? `Removed ${formatDateTime(device.revokedAt) || ''}`.trim()
                      : `Last seen ${device.lastSeenAt ? formatDateTime(device.lastSeenAt) : 'never (it has not synced yet)'}`}
                  </span>
                </div>

                {!device.revoked && confirmingId !== device.id && (
                  <button type="button" className={styles.revokeButton} onClick={() => setConfirmingId(device.id)} aria-label={`Remove ${name}`}>
                    Remove
                  </button>
                )}

                {!device.revoked && confirmingId === device.id && (
                  <div className={styles.confirm} role="alertdialog" aria-label={`Remove ${name}?`}>
                    <p>
                      <strong>Remove {name}?</strong> It will not be able to sync any more, starting with its next request. It keeps its own
                      encrypted copy of your files, readable with its PIN, until that copy is removed on the phone itself (the phone offers to
                      the next time it tries to sync). If the phone is lost, also change your password.
                    </p>
                    <div className={styles.row}>
                      <button type="button" className={styles.confirmYes} onClick={() => handleRevoke(device.id)} disabled={revokingId === device.id}>
                        {revokingId === device.id ? 'Removing…' : 'Yes, remove it'}
                      </button>
                      <button type="button" className={styles.secondary} onClick={() => setConfirmingId(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default PairedDevicesPanel;
