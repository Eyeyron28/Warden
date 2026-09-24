import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowRight, CheckSquare, DeviceMobile, Lifebuoy, LockKey, Trash } from '@phosphor-icons/react';

import wardenLogo from '../assets/warden_logo_badge.svg';
import UploadForm from '../components/UploadForm.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import NewMenu from '../components/NewMenu.jsx';
import NewFolderModal from '../components/NewFolderModal.jsx';
import FolderBreadcrumb from '../components/FolderBreadcrumb.jsx';
import FolderTile from '../components/FolderTile.jsx';
import Modal from '../components/Modal.jsx';
import {
  getAllDeviceAuth,
  getAllLocalDocuments,
  saveDocumentLocally,
  deleteLocalDocument,
  remapLocalDocumentId,
  getAllLocalFolders,
  saveLocalFolder,
  deleteLocalFolder,
} from '../services/localVault.js';
import {
  unlockLocalVault,
  lockLocalVault,
  decryptDocument,
  encryptDocument,
  computeChecksum,
  base64ToBytes,
  bytesToBase64,
  deriveKeyFromToken,
  wrapDEK,
  getUnwrappedDEK,
  generateSaltHex,
} from '../services/localCrypto.js';
import { pullDocuments, pushDocuments, deleteDocumentOnPC, deleteFolderOnPC } from '../services/syncService.js';
import {
  normalizeFolderPath,
  splitPath,
  joinPath,
  getImmediateChildren,
  pathStillExists,
} from '../utils/folderPath.js';
import { submitPhoneRecovery } from '../services/phoneRecoveryService.js';
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
  const [searchParams] = useSearchParams();
  // Pre-fills the recovery-help form below if this page was opened by
  // scanning the PC's recovery QR (PhoneRecoveryModal.jsx) - a directly-
  // openable `/phone?recover=<token>` URL, same pattern as PairPage's
  // `?apiBase=`. Still fully usable if typed in by hand instead.
  const recoverTokenFromUrl = searchParams.get('recover') || '';

  const [phase, setPhase] = useState('checking'); // checking | no-device | locked | unlocked
  const [deviceAuth, setDeviceAuth] = useState(null);

  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [unlocking, setUnlocking] = useState(false);

  const [documents, setDocuments] = useState([]);
  const [localFolders, setLocalFolders] = useState([]);
  const [docsLoading, setDocsLoading] = useState(false);

  // Same slash-delimited path model as the PC's VaultShell ("" = top level).
  const [currentPath, setCurrentPath] = useState('');
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  // Select mode (same model as the PC's VaultShell): loose documents by id,
  // folder tiles by full path; bulkPlan is the pending delete confirmation.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [selectedFolders, setSelectedFolders] = useState(new Set());
  const [bulkPlan, setBulkPlan] = useState(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');

  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryToken, setRecoveryToken] = useState(recoverTokenFromUrl);
  const [recoverySubmitting, setRecoverySubmitting] = useState(false);
  const [recoveryError, setRecoveryError] = useState('');
  const [recoverySuccess, setRecoverySuccess] = useState(false);

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
      const [docs, folderRecords] = await Promise.all([getAllLocalDocuments(), getAllLocalFolders()]);
      docs.sort((a, b) => new Date(b.cachedAt) - new Date(a.cachedAt));
      setDocuments(docs);
      setLocalFolders(folderRecords);
    } finally {
      setDocsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (phase === 'unlocked') loadDocuments();
  }, [phase, loadDocuments]);

  // Arrived here via the PC's recovery QR (see recoverTokenFromUrl above)
  // and just finished PIN-unlocking - open the recovery-help panel
  // automatically instead of making the owner find it themselves, since
  // that's clearly why they scanned the code in the first place.
  useEffect(() => {
    if (phase === 'unlocked' && recoverTokenFromUrl) setRecoveryOpen(true);
  }, [phase, recoverTokenFromUrl]);

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
    setLocalFolders([]);
    setCurrentPath('');
    setNewFolderOpen(false);
    setConfirmingDeleteId(null);
    exitSelectMode();
    setSyncMessage('');
    setSyncError('');
    setAddOpen(false);
    setAddError('');
    setRecoveryOpen(false);
    setRecoveryError('');
    setRecoverySuccess(false);
    setPhase('locked');
  };

  /**
   * "Help recover PC vault": this phone already holds the DEK unwrapped
   * in memory (from the PIN unlock above) - wraps a COPY of it under a
   * key derived from `recoveryToken` (the code read off the locked-out
   * PC's screen) plus a fresh salt generated for this one request, and
   * sends only that wrapped form to the PC via its existing deviceToken.
   * The raw DEK itself never leaves this function, let alone this device.
   */
  const handleSubmitRecovery = async (event) => {
    event.preventDefault();
    if (recoverySubmitting || !recoveryToken.trim()) return;

    const dek = getUnwrappedDEK();
    if (!dek) {
      setRecoveryError('This device is locked.');
      return;
    }

    setRecoverySubmitting(true);
    setRecoveryError('');
    try {
      const token = recoveryToken.trim();
      const saltHex = generateSaltHex();
      const kek = await deriveKeyFromToken(token, saltHex);
      const wrapped = await wrapDEK(dek, kek);

      await submitPhoneRecovery(deviceAuth.apiBase, deviceAuth.deviceToken, {
        recoveryToken: token,
        wrappedDEK: wrapped.wrappedKey,
        wrappedDEKIv: wrapped.iv,
        wrappedDEKAuthTag: wrapped.authTag,
        wrappedDEKSalt: saltHex,
      });

      setRecoverySuccess(true);
    } catch (err) {
      setRecoveryError(extractErrorMessage(err, 'Could not reach the PC. Check the code and try again.'));
    } finally {
      setRecoverySubmitting(false);
    }
  };

  /**
   * Encrypts and stores a file entirely offline: SHA-256 checksum of the
   * raw plaintext (same integrity purpose as the PC upload's checksum),
   * AES-256-GCM encryption via the DEK already unwrapped in memory from
   * PIN unlock, then straight into IndexedDB with a client-generated id
   * (there's no server _id yet) and syncStatus: "pending" - no network
   * call anywhere in this path. The saved shape (filename, folder,
   * expiryDate, encryptedBlob as an ArrayBuffer, iv/authTag/checksum as
   * strings, mimeType) is exactly what handleSync's push already reads
   * from local documents, so a phone-added file becomes push-eligible
   * with no changes needed there.
   */
  const handleAddDocument = async ({ file, expiryDate }) => {
    setAdding(true);
    setAddError('');
    try {
      const plaintext = await file.arrayBuffer();
      const checksum = await computeChecksum(plaintext);
      const { ciphertext, iv, authTag } = await encryptDocument(plaintext);

      await saveDocumentLocally({
        id: crypto.randomUUID(),
        filename: file.name,
        folder: currentPath || 'root',
        expiryDate: expiryDate || null,
        encryptedBlob: ciphertext,
        iv,
        authTag,
        checksum,
        mimeType: file.type || 'application/octet-stream',
        originDevice: 'phone',
        syncStatus: 'pending',
      });

      setAddOpen(false);
      await loadDocuments();
    } catch (err) {
      setAddError(err.message || 'Could not add this document.');
    } finally {
      setAdding(false);
    }
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

  /**
   * Deletes from the phone: same permanent delete and confirm step as the PC.
   * A document that was never synced exists only here, so it's just dropped
   * locally; otherwise the PC's DELETE /api/documents/:id is called first
   * (deviceToken auth) and the local copy only goes once that succeeded - a
   * 404 counts as success since it means the PC already deleted it.
   */
  const handleDelete = async (doc) => {
    setConfirmingDeleteId(null);
    setViewError('');
    setDeletingId(doc.id);
    try {
      if (doc.syncStatus !== 'pending') {
        try {
          await deleteDocumentOnPC(deviceAuth.apiBase, deviceAuth.deviceToken, doc.id);
        } catch (err) {
          if (err?.response?.status !== 404) throw err;
        }
      }
      await deleteLocalDocument(doc.id);
      await loadDocuments();
    } catch (err) {
      setViewError(extractErrorMessage(err, 'Could not delete this document. Is the PC reachable?'));
    } finally {
      setDeletingId(null);
    }
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setSelectedFolders(new Set());
    setBulkPlan(null);
  };

  const toggleInSet = (setter, value) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });

  // Resolves the selection to a de-duplicated document list: loose picks plus
  // everything nested under any selected folder (same rule as the PC).
  const resolveSelection = () => {
    const folderPaths = [...selectedFolders];
    const nested = new Set();
    for (const doc of documents) {
      const path = normalizeFolderPath(doc.folder);
      if (folderPaths.some((folder) => path === folder || path.startsWith(`${folder}/`))) {
        nested.add(doc.id);
      }
    }
    const looseCount = [...selectedIds].filter((id) => !nested.has(id)).length;
    return {
      folderPaths,
      docs: documents.filter((doc) => selectedIds.has(doc.id) || nested.has(doc.id)),
      looseCount,
      nestedCount: nested.size,
    };
  };

  const describePlan = (plan) => {
    const parts = [];
    if (plan.looseCount > 0) {
      parts.push(`${plan.looseCount} file${plan.looseCount === 1 ? '' : 's'}`);
    }
    if (plan.folderPaths.length > 0) {
      const folders = `${plan.folderPaths.length} folder${plan.folderPaths.length === 1 ? '' : 's'}`;
      parts.push(
        plan.nestedCount > 0
          ? `${folders} containing ${plan.nestedCount} document${plan.nestedCount === 1 ? '' : 's'}`
          : `${folders} (empty)`
      );
    }
    return `Delete ${parts.join(' and ')}? This can't be undone.`;
  };

  const handleBulkDeleteClick = () => {
    if (selectedIds.size + selectedFolders.size === 0) return;
    const plan = resolveSelection();
    if (plan.docs.length === 0) runBulkDelete(plan);
    else setBulkPlan(plan);
  };

  // Same per-document rules as handleDelete (never-synced = local only, PC
  // 404 = already gone); allSettled so one failure doesn't strand the rest.
  // A folder (and its markers on both sides) only goes if nothing under it
  // survived.
  const runBulkDelete = async (plan) => {
    setBulkPlan(null);
    setViewError('');
    setBulkDeleting(true);
    const results = await Promise.allSettled(
      plan.docs.map(async (doc) => {
        if (doc.syncStatus !== 'pending') {
          try {
            await deleteDocumentOnPC(deviceAuth.apiBase, deviceAuth.deviceToken, doc.id);
          } catch (err) {
            if (err?.response?.status !== 404) throw err;
          }
        }
        await deleteLocalDocument(doc.id);
      })
    );
    const failed = plan.docs.filter((_, index) => results[index].status === 'rejected');
    const failedIds = new Set(failed.map((doc) => doc.id));
    const planIds = new Set(plan.docs.map((doc) => doc.id));

    const leftoverPaths = documents
      .filter((doc) => !planIds.has(doc.id) || failedIds.has(doc.id))
      .map((doc) => normalizeFolderPath(doc.folder));
    for (const folderPath of plan.folderPaths) {
      const hasLeftovers = leftoverPaths.some(
        (path) => path === folderPath || path.startsWith(`${folderPath}/`)
      );
      if (hasLeftovers) continue;
      // eslint-disable-next-line no-await-in-loop
      await deleteFolderOnPC(deviceAuth.apiBase, deviceAuth.deviceToken, folderPath).catch(() => {});
      for (const record of localFolders) {
        if (record.name === folderPath || record.name.startsWith(`${folderPath}/`)) {
          // eslint-disable-next-line no-await-in-loop
          await deleteLocalFolder(record.name);
        }
      }
    }

    await loadDocuments();
    if (failed.length > 0) {
      setViewError(
        `Could not delete ${failed.length} of ${plan.docs.length} document${plan.docs.length === 1 ? '' : 's'}. Is the PC reachable?`
      );
    }
    setBulkDeleting(false);
    exitSelectMode();
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncError('');
    setSyncMessage('');
    try {
      const localDocs = await getAllLocalDocuments();
      const knownDocumentIds = localDocs.map((doc) => doc.id);

      const { documents: pulled, index, folders: serverFolders } = await pullDocuments(
        deviceAuth.apiBase,
        deviceAuth.deviceToken,
        knownDocumentIds
      );
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

      // Reconcile what the phone already had against the PC's full index:
      // a synced document missing from it was deleted on the PC, and one
      // whose filename/folder/expiry differ was edited there. Documents
      // still 'pending' exist only on this phone and are never pruned.
      const serverIndex = new Map(index.map((entry) => [String(entry.id), entry]));
      let removedCount = 0;
      for (const doc of localDocs) {
        if (doc.syncStatus !== 'synced') continue;
        const remote = serverIndex.get(String(doc.id));
        if (!remote) {
          // eslint-disable-next-line no-await-in-loop
          await deleteLocalDocument(doc.id);
          removedCount += 1;
        } else if (
          remote.filename !== doc.filename ||
          remote.folder !== doc.folder ||
          (remote.expiryDate || null) !== (doc.expiryDate || null)
        ) {
          // eslint-disable-next-line no-await-in-loop
          await saveDocumentLocally({
            ...doc,
            filename: remote.filename,
            folder: remote.folder,
            expiryDate: remote.expiryDate,
          });
        }
      }

      // Same for empty-folder records: mirror the PC's list, keep pending ones.
      const localFolderRecords = await getAllLocalFolders();
      const serverFolderSet = new Set(serverFolders);
      for (const record of localFolderRecords) {
        if (record.syncStatus === 'synced' && !serverFolderSet.has(record.name)) {
          // eslint-disable-next-line no-await-in-loop
          await deleteLocalFolder(record.name);
        }
      }
      const localFolderNames = new Set(localFolderRecords.map((record) => record.name));
      for (const name of serverFolders) {
        if (!localFolderNames.has(name)) {
          // eslint-disable-next-line no-await-in-loop
          await saveLocalFolder({ name, syncStatus: 'synced' });
        }
      }

      const pending = localDocs.filter((doc) => doc.syncStatus === 'pending');
      const pendingFolders = localFolderRecords.filter((record) => record.syncStatus === 'pending');
      let pushedCount = 0;

      if (pending.length > 0 || pendingFolders.length > 0) {
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

        const result = await pushDocuments(
          deviceAuth.apiBase,
          deviceAuth.deviceToken,
          newDocuments,
          pendingFolders.map((record) => record.name)
        );
        for (const { localId, id } of result.idMap) {
          const original = pending.find((doc) => doc.id === localId);
          if (original && id) {
            // eslint-disable-next-line no-await-in-loop -- small batches, sequential IndexedDB writes are fine here
            await remapLocalDocumentId(localId, { ...original, id, syncStatus: 'synced' });
          }
        }
        for (const record of pendingFolders) {
          // eslint-disable-next-line no-await-in-loop
          await saveLocalFolder({ name: record.name, syncStatus: 'synced' });
        }
        pushedCount = result.idMap.length;
      }

      await loadDocuments();
      setSyncMessage(
        `Synced: pulled ${pulled.length}, pushed ${pushedCount}, removed ${removedCount}.`
      );
    } catch (err) {
      setSyncError(extractErrorMessage(err, 'Sync failed.'));
    } finally {
      setSyncing(false);
    }
  };

  // Folder tree for the current path - derived from document folder strings
  // plus the empty-folder records, exactly like VaultShell (utils/folderPath.js).
  const subfolderNames = useMemo(() => {
    const allPaths = new Set();
    for (const doc of documents) {
      const path = normalizeFolderPath(doc.folder);
      if (path) allPaths.add(path);
    }
    for (const record of localFolders) {
      const path = normalizeFolderPath(record.name);
      if (path) allPaths.add(path);
    }
    return getImmediateChildren(allPaths, currentPath);
  }, [documents, localFolders, currentPath]);

  const subfolderItemCounts = useMemo(() => {
    const counts = new Map();
    for (const name of subfolderNames) {
      const subfolderPath = joinPath([...splitPath(currentPath), name]);
      const prefix = `${subfolderPath}/`;
      counts.set(
        name,
        documents.filter((doc) => {
          const path = normalizeFolderPath(doc.folder);
          return path === subfolderPath || path.startsWith(prefix);
        }).length
      );
    }
    return counts;
  }, [documents, subfolderNames, currentPath]);

  const visibleDocuments = useMemo(
    () => documents.filter((doc) => normalizeFolderPath(doc.folder) === currentPath),
    [documents, currentPath]
  );

  // Bounce to the top level if the folder being viewed vanished (its last
  // document was deleted/synced away and it had no folder record).
  useEffect(() => {
    if (phase !== 'unlocked' || docsLoading) return;
    const docFolders = documents.map((doc) => normalizeFolderPath(doc.folder));
    const folderNames = localFolders.map((record) => normalizeFolderPath(record.name));
    if (!pathStillExists(currentPath, docFolders, folderNames)) setCurrentPath('');
  }, [phase, docsLoading, documents, localFolders, currentPath]);

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
              <div className={styles.vaultHeaderActions}>
                <NewMenu
                  allowFolderUpload={false}
                  onOpenNewFolder={() => setNewFolderOpen(true)}
                  onOpenUploadForm={() => {
                    setAddOpen(true);
                    setAddError('');
                  }}
                />
                {!selectMode && documents.length > 0 && (
                  <button
                    type="button"
                    className={styles.addButton}
                    onClick={() => {
                      setSelectMode(true);
                      setSelectedIds(new Set());
                      setSelectedFolders(new Set());
                    }}
                  >
                    <CheckSquare size={16} weight="bold" />
                    <span>Select</span>
                  </button>
                )}
                <button type="button" className={styles.syncButton} onClick={handleSync} disabled={syncing}>
                  {syncing ? 'Syncing...' : 'Sync now'}
                </button>
                <button
                  type="button"
                  className={styles.syncButton}
                  onClick={() => {
                    setRecoveryOpen((open) => !open);
                    setRecoveryError('');
                    setRecoverySuccess(false);
                  }}
                >
                  <Lifebuoy size={16} weight="bold" />
                  <span>Help recover PC vault</span>
                </button>
              </div>
            </div>

            {addOpen && (
              <UploadForm
                onSubmit={handleAddDocument}
                onCancel={() => {
                  setAddOpen(false);
                  setAddError('');
                }}
                uploading={adding}
                progress={100}
                error={addError}
                destinationLabel={currentPath || 'Documents'}
              />
            )}

            {recoveryOpen && (
              <div className={styles.formPanel}>
                {recoverySuccess ? (
                  <>
                    <p className={styles.hint}>
                      Sent. Go back to the locked-out PC and finish choosing a new master password
                      there.
                    </p>
                    <button
                      type="button"
                      className={styles.submitButton}
                      onClick={() => setRecoveryOpen(false)}
                    >
                      Done
                    </button>
                  </>
                ) : (
                  <form className={styles.form} onSubmit={handleSubmitRecovery} noValidate>
                    <div className={styles.field}>
                      <label htmlFor="recovery-token" className={styles.fieldLabel}>
                        Code shown on the locked-out PC
                      </label>
                      <input
                        id="recovery-token"
                        type="text"
                        className={styles.textInput}
                        value={recoveryToken}
                        onChange={(event) => setRecoveryToken(event.target.value)}
                        placeholder="Paste or type the code"
                        autoComplete="off"
                        spellCheck={false}
                        autoFocus={!recoverTokenFromUrl}
                      />
                      {recoveryError && <p className={styles.fieldError}>{recoveryError}</p>}
                    </div>

                    <button
                      type="submit"
                      className={styles.submitButton}
                      disabled={recoverySubmitting || !recoveryToken.trim()}
                    >
                      <span>{recoverySubmitting ? 'Sending...' : 'Send to PC'}</span>
                      <ArrowRight size={18} weight="bold" />
                    </button>
                  </form>
                )}
              </div>
            )}

            {syncMessage && <p className={styles.syncMessage}>{syncMessage}</p>}
            {syncError && <p className={styles.fieldError}>{syncError}</p>}
            {viewError && <p className={styles.fieldError}>{viewError}</p>}

            <FolderBreadcrumb path={currentPath} onNavigate={setCurrentPath} />

            {subfolderNames.length > 0 && (
              <ul className={styles.folderGrid}>
                {subfolderNames.map((name) => (
                  <FolderTile
                    key={name}
                    name={name}
                    itemCount={subfolderItemCounts.get(name) ?? 0}
                    onOpen={() => setCurrentPath(joinPath([...splitPath(currentPath), name]))}
                    selectMode={selectMode}
                    selected={selectedFolders.has(joinPath([...splitPath(currentPath), name]))}
                    onToggleSelect={() =>
                      toggleInSet(setSelectedFolders, joinPath([...splitPath(currentPath), name]))
                    }
                  />
                ))}
              </ul>
            )}

            {!docsLoading && visibleDocuments.length === 0 && subfolderNames.length === 0 && (
              <p className={styles.hint}>
                {documents.length === 0 && !currentPath
                  ? 'Nothing stored locally yet - try syncing, or add a document.'
                  : 'This folder is empty.'}
              </p>
            )}

            {visibleDocuments.length > 0 && (
              <ul className={styles.list}>
                {visibleDocuments.map((doc) => (
                  <li key={doc.id} className={styles.row}>
                    {selectMode && (
                      <input
                        type="checkbox"
                        className={styles.selectCheckbox}
                        checked={selectedIds.has(doc.id)}
                        onChange={() => toggleInSet(setSelectedIds, doc.id)}
                        aria-label={`Select ${doc.filename}`}
                      />
                    )}
                    <div className={styles.meta}>
                      <span className={styles.filenameRow}>
                        <span className={styles.filename}>{doc.filename}</span>
                        {doc.syncStatus === 'pending' && (
                          <StatusBadge label="Pending sync" tone="accent" dot />
                        )}
                      </span>
                      <span className={styles.sub}>{doc.folder || 'root'}</span>
                    </div>
                    <div className={styles.rowActions}>
                      {selectMode ? null : confirmingDeleteId === doc.id ? (
                        <>
                          <span className={styles.confirmLabel}>Delete?</span>
                          <button
                            type="button"
                            className={styles.confirmYes}
                            onClick={() => handleDelete(doc)}
                            disabled={deletingId === doc.id}
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            className={styles.viewButton}
                            onClick={() => setConfirmingDeleteId(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className={styles.viewButton}
                            onClick={() => handleView(doc)}
                            disabled={viewingId === doc.id}
                          >
                            {viewingId === doc.id ? 'Opening...' : 'View'}
                          </button>
                          <button
                            type="button"
                            className={styles.deleteButton}
                            onClick={() => setConfirmingDeleteId(doc.id)}
                            disabled={deletingId === doc.id}
                            aria-label={`Delete ${doc.filename}`}
                          >
                            <Trash size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {selectMode && (
              <div className={styles.bulkBar}>
                <span className={styles.bulkCount}>
                  {selectedIds.size + selectedFolders.size} selected
                </span>
                <div className={styles.bulkActions}>
                  <button
                    type="button"
                    className={styles.confirmYes}
                    onClick={handleBulkDeleteClick}
                    disabled={selectedIds.size + selectedFolders.size === 0 || bulkDeleting}
                  >
                    {bulkDeleting ? 'Deleting...' : 'Delete'}
                  </button>
                  <button type="button" className={styles.viewButton} onClick={exitSelectMode}>
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {bulkPlan && (
        <Modal title="Delete selection?" onClose={() => setBulkPlan(null)}>
          <p className={styles.confirmText}>{describePlan(bulkPlan)}</p>
          <div className={styles.confirmButtons}>
            <button type="button" className={styles.viewButton} onClick={() => setBulkPlan(null)}>
              Cancel
            </button>
            <button type="button" className={styles.confirmYes} onClick={() => runBulkDelete(bulkPlan)}>
              Delete
            </button>
          </div>
        </Modal>
      )}

      {newFolderOpen && (
        <NewFolderModal
          currentPath={currentPath}
          onClose={() => setNewFolderOpen(false)}
          onCreated={() => loadDocuments()}
          createFolderFn={(fullPath) => saveLocalFolder({ name: fullPath, syncStatus: 'pending' })}
        />
      )}
    </div>
  );
}

export default PhoneVault;
