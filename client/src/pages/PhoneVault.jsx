import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, DeviceMobile, LockKey } from '@phosphor-icons/react';

import wardenLogo from '../assets/warden_logo_badge.svg';
import {
  getAllDeviceAuth,
  getAllLocalDocuments,
  saveDocumentLocally,
  remapLocalDocumentId,
} from '../services/localVault.js';
import {
  unlockLocalVault,
  lockLocalVault,
  decryptDocument,
  base64ToBytes,
  bytesToBase64,
} from '../services/localCrypto.js';
import { pullDocuments, pushDocuments } from '../services/syncService.js';
import { extractErrorMessage } from '../services/api.js';
import styles from './PhoneVault.module.css';

/**
 * The phone's own local vault view (/phone) - entirely outside the
 * PC-session-gated App flow, same spirit as SharedDocumentPage/PairPage.
 * On load it checks IndexedDB's "deviceAuth" store (populated once by
 * PairPage.jsx at pairing time): if a paired device record exists, this
 * shows PIN entry instead of the master-password LockScreen; the master
 * password is never asked for again after pairing.
 *
 * Once unlocked, the vault view lists documents from the phone's own
 * IndexedDB "documents" store (not a live PC connection) and offers a
 * "Sync now" button to reconcile with the PC over POST /api/sync/pull
 * and /push, authenticated with this device's deviceToken.
 */
function PhoneVault() {
  const [phase, setPhase] = useState('checking'); // checking | no-device | locked | unlocked
  const [deviceAuth, setDeviceAuth] = useState(null);

  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [unlocking, setUnlocking] = useState(false);

  const [documents, setDocuments] = useState([]);
  const [docsLoading, setDocsLoading] = useState(false);

  const [viewingId, setViewingId] = useState(null);
  const [viewError, setViewError] = useState('');

  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [syncMessage, setSyncMessage] = useState('');

  useEffect(() => {
    let cancelled = false;

    getAllDeviceAuth()
      .then((records) => {
        if (cancelled) return;
        if (records.length === 0) {
          setPhase('no-device');
        } else {
          // Single-phone assumption for this pass: if this browser ever
          // paired more than once, the most recent pairing wins.
          const mostRecent = [...records].sort(
            (a, b) => new Date(b.pairedAt) - new Date(a.pairedAt)
          )[0];
          setDeviceAuth(mostRecent);
          setPhase('locked');
        }
      })
      .catch(() => {
        if (!cancelled) setPhase('no-device');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const loadDocuments = useCallback(async () => {
    setDocsLoading(true);
    try {
      const docs = await getAllLocalDocuments();
      docs.sort((a, b) => new Date(b.cachedAt) - new Date(a.cachedAt));
      setDocuments(docs);
    } finally {
      setDocsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (phase === 'unlocked') loadDocuments();
  }, [phase, loadDocuments]);

  const handleUnlock = async (event) => {
    event.preventDefault();
    if (unlocking || !pin) return;

    setUnlocking(true);
    setPinError('');
    try {
      await unlockLocalVault(pin, deviceAuth);
      setPin('');
      setPhase('unlocked');
    } catch (err) {
      setPinError(err.message || 'Incorrect PIN.');
    } finally {
      setUnlocking(false);
    }
  };

  const handleLock = () => {
    lockLocalVault();
    setDocuments([]);
    setSyncMessage('');
    setSyncError('');
    setPhase('locked');
  };

  const handleView = async (doc) => {
    setViewError('');
    setViewingId(doc.id);
    try {
      const blob = new Blob([await decryptDocument(doc.encryptedBlob, doc.iv, doc.authTag)], {
        type: doc.mimeType || 'application/octet-stream',
      });
      const url = URL.createObjectURL(blob);
      const opened = window.open(url, '_blank');
      if (!opened) {
        const link = document.createElement('a');
        link.href = url;
        link.download = doc.filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setViewError(err.message || 'Could not open this document.');
    } finally {
      setViewingId(null);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncError('');
    setSyncMessage('');
    try {
      const localDocs = await getAllLocalDocuments();
      const knownDocumentIds = localDocs.map((doc) => doc.id);

      const pulled = await pullDocuments(deviceAuth.apiBase, deviceAuth.deviceToken, knownDocumentIds);
      for (const doc of pulled) {
        // eslint-disable-next-line no-await-in-loop -- small batches, sequential IndexedDB writes are fine here
        await saveDocumentLocally({
          id: doc.id,
          filename: doc.filename,
          folder: doc.folder,
          expiryDate: doc.expiryDate,
          encryptedBlob: base64ToBytes(doc.encryptedBlob).buffer,
          iv: doc.iv,
          authTag: doc.authTag,
          checksum: doc.checksum,
          mimeType: doc.mimeType,
          syncStatus: 'synced',
        });
      }

      const pending = localDocs.filter((doc) => doc.syncStatus === 'pending');
      let pushedCount = 0;

      if (pending.length > 0) {
        const newDocuments = pending.map((doc) => ({
          localId: doc.id,
          filename: doc.filename,
          folder: doc.folder,
          encryptedBlob: bytesToBase64(new Uint8Array(doc.encryptedBlob)),
          iv: doc.iv,
          authTag: doc.authTag,
          checksum: doc.checksum,
          expiryDate: doc.expiryDate,
          mimeType: doc.mimeType,
        }));

        const result = await pushDocuments(deviceAuth.apiBase, deviceAuth.deviceToken, newDocuments);
        for (const { localId, id } of result.idMap) {
          const original = pending.find((doc) => doc.id === localId);
          if (original && id) {
            // eslint-disable-next-line no-await-in-loop -- small batches, sequential IndexedDB writes are fine here
            await remapLocalDocumentId(localId, { ...original, id, syncStatus: 'synced' });
          }
        }
        pushedCount = result.idMap.length;
      }

      await loadDocuments();
      setSyncMessage(`Synced: pulled ${pulled.length}, pushed ${pushedCount}.`);
    } catch (err) {
      setSyncError(extractErrorMessage(err, 'Sync failed.'));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.brand}>
        <img src={wardenLogo} alt="" className={styles.brandMark} />
        <span className={styles.brandText}>Warden</span>
        {phase === 'unlocked' && (
          <button type="button" className={styles.lockButton} onClick={handleLock}>
            <LockKey size={14} weight="bold" />
            <span>Lock</span>
          </button>
        )}
      </header>

      <main className={styles.content}>
        {phase === 'checking' && <p className={styles.hint}>Checking this device...</p>}

        {phase === 'no-device' && (
          <div className={styles.emptyState}>
            <DeviceMobile size={40} weight="light" className={styles.emptyIcon} />
            <h1 className={styles.emptyTitle}>This device isn't paired yet</h1>
            <p className={styles.emptyBody}>
              Pair this phone with your vault first - from your PC, open "Pair a device" and scan
              the QR code.
            </p>
          </div>
        )}

        {phase === 'locked' && (
          <div className={styles.formPanel}>
            <div className={styles.copy}>
              <h1 className={styles.title}>Enter your PIN</h1>
              <p className={styles.subtitle}>
                {deviceAuth?.deviceId ? 'Unlock this device’s local vault.' : 'Unlock this device.'}
              </p>
            </div>

            <form className={styles.form} onSubmit={handleUnlock} noValidate>
              <div className={styles.field}>
                <label htmlFor="local-pin" className={styles.fieldLabel}>
                  Device PIN
                </label>
                <input
                  id="local-pin"
                  type="password"
                  inputMode="numeric"
                  className={styles.textInput}
                  value={pin}
                  onChange={(event) => {
                    setPin(event.target.value);
                    setPinError('');
                  }}
                  placeholder="Enter your PIN"
                  autoFocus
                  autoComplete="off"
                />
                {pinError && <p className={styles.fieldError}>{pinError}</p>}
              </div>

              <button type="submit" className={styles.submitButton} disabled={unlocking || !pin}>
                <span>{unlocking ? 'Unlocking...' : 'Unlock'}</span>
                <ArrowRight size={18} weight="bold" />
              </button>
            </form>
          </div>
        )}

        {phase === 'unlocked' && (
          <div className={styles.vaultPanel}>
            <div className={styles.vaultHeader}>
              <div>
                <h1 className={styles.title}>Local documents</h1>
                <p className={styles.hint}>
                  {docsLoading
                    ? 'Loading...'
                    : `${documents.length} document${documents.length === 1 ? '' : 's'} stored on this device`}
                </p>
              </div>
              <button type="button" className={styles.syncButton} onClick={handleSync} disabled={syncing}>
                {syncing ? 'Syncing...' : 'Sync now'}
              </button>
            </div>

            {syncMessage && <p className={styles.syncMessage}>{syncMessage}</p>}
            {syncError && <p className={styles.fieldError}>{syncError}</p>}
            {viewError && <p className={styles.fieldError}>{viewError}</p>}

            {!docsLoading && documents.length === 0 && (
              <p className={styles.hint}>Nothing stored locally yet - try syncing.</p>
            )}

            {documents.length > 0 && (
              <ul className={styles.list}>
                {documents.map((doc) => (
                  <li key={doc.id} className={styles.row}>
                    <div className={styles.meta}>
                      <span className={styles.filename}>{doc.filename}</span>
                      <span className={styles.sub}>
                        {doc.folder || 'root'} · {doc.syncStatus}
                      </span>
                    </div>
                    <button
                      type="button"
                      className={styles.viewButton}
                      onClick={() => handleView(doc)}
                      disabled={viewingId === doc.id}
                    >
                      {viewingId === doc.id ? 'Opening...' : 'View'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default PhoneVault;
