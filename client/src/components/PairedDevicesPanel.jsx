import { useCallback, useEffect, useState } from 'react';
import { Trash } from '@phosphor-icons/react';

import { listDevices, revokeDevice } from '../services/devicesService.js';
import { extractErrorMessage } from '../services/api.js';
import { formatDateTime } from '../utils/formatDate.js';
import styles from './PairedDevicesPanel.module.css';

/**
 * Owner-side device management: lists every PairedDevice and lets the
 * owner cut one off. Revoking flips PairedDevice.revoked - the actual
 * security boundary is requireDeviceAuth (server/middleware/
 * requireDeviceAuth.js) checking that same flag on every sync request, so
 * a revoked device's deviceToken (still sitting in its own IndexedDB)
 * stops working immediately, not just on its next pairing attempt.
 */
function PairedDevicesPanel({ onCancel }) {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirmingRevokeId, setConfirmingRevokeId] = useState(null);
  const [revokingId, setRevokingId] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listDevices();
      setDevices(data);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not load paired devices.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleRevokeClick = (deviceId) => {
    if (confirmingRevokeId === deviceId) {
      setConfirmingRevokeId(null);
      handleRevoke(deviceId);
    } else {
      setConfirmingRevokeId(deviceId);
    }
  };

  const handleRevoke = async (deviceId) => {
    setRevokingId(deviceId);
    setError('');
    try {
      await revokeDevice(deviceId);
      setDevices((prev) =>
        prev.map((device) => (device.id === deviceId ? { ...device, revoked: true } : device))
      );
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not revoke this device.'));
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.label}>Paired devices</span>
        <button type="button" className={styles.cancelButton} onClick={onCancel}>
          Close
        </button>
      </div>

      {loading && <p className={styles.hint}>Loading...</p>}

      {!loading && error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {!loading && !error && devices.length === 0 && (
        <p className={styles.hint}>No devices have been paired yet.</p>
      )}

      {devices.length > 0 && (
        <ul className={styles.list}>
          {devices.map((device) => (
            <li key={device.id} className={styles.row}>
              <div className={styles.meta}>
                <span className={styles.deviceName}>{device.deviceName || 'Unnamed device'}</span>
                <span className={styles.sub}>Paired {formatDateTime(device.pairedAt)}</span>
              </div>

              {device.revoked ? (
                <span className={styles.revokedLabel}>Revoked</span>
              ) : confirmingRevokeId !== device.id ? (
                <button
                  type="button"
                  className={styles.revokeButton}
                  onClick={() => handleRevokeClick(device.id)}
                  aria-label={`Revoke ${device.deviceName || 'this device'}`}
                >
                  <Trash size={14} />
                  <span>Revoke</span>
                </button>
              ) : (
                <div className={styles.confirmRow}>
                  <span className={styles.confirmLabel}>Revoke?</span>
                  <button
                    type="button"
                    className={styles.confirmYes}
                    onClick={() => handleRevokeClick(device.id)}
                    disabled={revokingId === device.id}
                  >
                    {revokingId === device.id ? 'Revoking...' : 'Confirm'}
                  </button>
                  <button
                    type="button"
                    className={styles.confirmNo}
                    onClick={() => setConfirmingRevokeId(null)}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default PairedDevicesPanel;
