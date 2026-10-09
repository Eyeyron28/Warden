import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  updateDeviceAuth,
  wipeLocalVault,
} from '../services/localVault.js';
import {
  unlockLocalVault,
  lockLocalVault,
  decryptDocument,
  encryptDocument,
  computeChecksum,
  rewrapWithNewPin,
  deriveKeyFromToken,
  wrapDEK,
  getUnwrappedDEK,
  generateSaltHex,
} from '../services/localCrypto.js';
import {
  listDocumentPage,
  listServerFolders,
  fetchDocumentContent,
  pushDocument,
  pushFolder,
  deleteDocumentOnPC,
  deleteFolderOnPC,
} from '../services/syncService.js';
import { runSync } from '../utils/phoneSync.js';
import { checkPin } from '../utils/pinRules.js';
import { afterRightPin, afterWrongPin, describeWait, readLockout } from '../utils/pinLockout.js';
import {
  normalizeFolderPath,
  splitPath,
  joinPath,
  getImmediateChildren,
  pathStillExists,
} from '../utils/folderPath.js';
import { submitPhoneRecovery } from '../services/phoneRecoveryService.js';
import { sameOriginApiBase } from '../utils/apiOrigin.js';
import { extractErrorMessage } from '../services/api.js';
import styles from './PhoneVault.module.css';

/** One line for what a running sync is doing. */
function progressText(progress) {
  const position = `${Math.min(progress.done + 1, progress.total)} of ${progress.total}`;
  const name = progress.current ? ` - ${progress.current}` : '';
  if (progress.phase === 'listing') return `Checking your account... (${progress.done} files seen)`;
  if (progress.phase === 'downloading') return progress.total === 0 ? 'Nothing new to download.' : `Downloading ${position}${name}`;
  return progress.total === 0 ? 'Nothing to upload.' : `Uploading ${position}${name}`;
}

/**
 * The phone's own local vault view (/phone) - entirely outside the
 * PC-session-gated App flow, same spirit as SharedDocumentPage/PairPage.
 * On load it checks IndexedDB's "deviceAuth" store (populated once by
 * PairPage.jsx at pairing time): if a paired device record exists, this
 * shows PIN entry instead of the email-and-password login; the master
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
  // `/pair/:token`. Still fully usable if typed in by hand instead.
  const recoverTokenFromUrl = searchParams.get('recover') || '';

  const [phase, setPhase] = useState('checking'); // checking | no-device | locked | locked-out | new-pin | unlocked
  const [deviceAuth, setDeviceAuth] = useState(null);

  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [now, setNow] = useState(Date.now()); // ticks while a wrong-PIN wait is running
  // The forced new PIN (an old wrap, or a PIN that no longer meets the rules).
  const [newPin, setNewPin] = useState('');
  const [newPinConfirm, setNewPinConfirm] = useState('');
  const [newPinReason, setNewPinReason] = useState(null);
  const [newPinError, setNewPinError] = useState('');
  const [savingPin, setSavingPin] = useState(false);
  const oldPin = useRef('');
  const [resetOpen, setResetOpen] = useState(false);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine !== false);

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
  const [syncProgress, setSyncProgress] = useState(null); // { phase, done, total, current }
  const [syncFailures, setSyncFailures] = useState([]);
  const [revokedNotice, setRevokedNotice] = useState('');
  const syncAbort = useRef(null);

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
          // The stored apiBase is NOT trusted: older pairings saved whatever
          // address the pairing link carried. Every request from this page
          // goes to this page's own origin instead (utils/apiOrigin.js) -
          // the origin that paired is the one whose IndexedDB this is.
          setDeviceAuth({ ...mostRecent, apiBase: sameOriginApiBase() });
          setPhase(readLockout(mostRecent.unlock).lockedOut ? 'locked-out' : 'locked');
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

  // Online / offline, so the screen can say so instead of failing quietly.
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  // While a wrong-PIN wait is running, tick once a second so the countdown moves.
  const lockout = readLockout(deviceAuth?.unlock, now);
  useEffect(() => {
    if (phase !== 'locked' || lockout.waitMs <= 0) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [phase, lockout.waitMs]);

  const saveUnlockState = async (unlock) => {
    setDeviceAuth((current) => ({ ...current, unlock }));
    try {
      await updateDeviceAuth(deviceAuth.deviceId, { unlock });
    } catch {
      // The in-memory copy still limits this page; nothing more can be done if storage refuses.
    }
  };

  const handleUnlock = async (event) => {
    event.preventDefault();
    if (unlocking || !pin) return;
    const current = readLockout(deviceAuth.unlock);
    if (current.lockedOut) {
      setPhase('locked-out');
      return;
    }
    if (current.waitMs > 0) return;

    setUnlocking(true);
    setPinError('');
    try {
      const outcome = await unlockLocalVault(pin, deviceAuth);
      await saveUnlockState(afterRightPin());
      setNow(Date.now());
      if (outcome.needsNewPin) {
        // An old wrap (cheaper key derivation) or a PIN that no longer meets the rules:
        // the vault is open, but a new PIN must be chosen before it is used.
        oldPin.current = pin;
        setNewPinReason(outcome.reason);
        setPin('');
        setPhase('new-pin');
      } else {
        setPin('');
        setPhase('unlocked');
      }
    } catch (err) {
      if (err?.message === 'Incorrect PIN.') {
        const next = afterWrongPin(deviceAuth.unlock);
        await saveUnlockState(next);
        setNow(Date.now());
        const after = readLockout(next);
        if (after.lockedOut) {
          setPin('');
          setPhase('locked-out');
        } else {
          setPinError(`Incorrect PIN. ${after.triesLeft} ${after.triesLeft === 1 ? 'try' : 'tries'} left before this phone locks.`);
        }
      } else {
        setPinError('This browser could not unlock the vault. Reload the page and try again.');
      }
    } finally {
      setUnlocking(false);
    }
  };

  const newPinCheck = checkPin(newPin);
  const handleSetNewPin = async (event) => {
    event.preventDefault();
    if (savingPin) return;
    if (!newPinCheck.ok) {
      setNewPinError(newPinCheck.message || 'Choose a PIN that meets the rules above.');
      return;
    }
    if (newPin === oldPin.current) {
      setNewPinError('Choose a different PIN from the old one.');
      return;
    }
    if (newPin !== newPinConfirm) {
      setNewPinError('The two PINs do not match.');
      return;
    }
    setSavingPin(true);
    setNewPinError('');
    try {
      // Re-wrapped here, in this browser, from the key already open in memory; nothing is sent anywhere.
      const wrap = await rewrapWithNewPin(newPin);
      await updateDeviceAuth(deviceAuth.deviceId, wrap);
      setDeviceAuth((current) => ({ ...current, ...wrap }));
      oldPin.current = '';
      setNewPin('');
      setNewPinConfirm('');
      setPhase('unlocked');
    } catch {
      setNewPinError('Could not save the new PIN on this phone. Try again.');
    } finally {
      setSavingPin(false);
    }
  };

  // The way back after a lockout or a removed pairing: wipe this phone's copy, then pair again from Devices.
  const handleResetDevice = async () => {
    lockLocalVault();
    await wipeLocalVault();
    setResetOpen(false);
    setDeviceAuth(null);
    setDocuments([]);
    setLocalFolders([]);
    setRevokedNotice('');
    setPhase('no-device');
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
    let failedFolderCount = 0;
    for (const folderPath of plan.folderPaths) {
      const hasLeftovers = leftoverPaths.some(
        (path) => path === folderPath || path.startsWith(`${folderPath}/`)
      );
      if (hasLeftovers) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await deleteFolderOnPC(deviceAuth.apiBase, deviceAuth.deviceToken, folderPath);
      } catch {
        // Used to be swallowed silently. The local copy still goes (the
        // documents inside are already deleted), but say so - the folder
        // will reappear on the next sync if the PC still has it.
        failedFolderCount += 1;
      }
      for (const record of localFolders) {
        if (record.name === folderPath || record.name.startsWith(`${folderPath}/`)) {
          // eslint-disable-next-line no-await-in-loop
          await deleteLocalFolder(record.name);
        }
      }
    }

    await loadDocuments();
    const problems = [];
    if (failed.length > 0) {
      problems.push(
        `Could not delete ${failed.length} of ${plan.docs.length} document${plan.docs.length === 1 ? '' : 's'}.`
      );
    }
    if (failedFolderCount > 0) {
      problems.push(
        `Could not remove ${failedFolderCount} folder${failedFolderCount === 1 ? '' : 's'} on the PC - it may come back on the next sync.`
      );
    }
    if (problems.length > 0) setViewError(`${problems.join(' ')} Is the PC reachable?`);
    setBulkDeleting(false);
    exitSelectMode();
  };

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncError('');
    setSyncMessage('');
    setSyncFailures([]);
    setSyncProgress({ phase: 'listing', done: 0, total: 0 });
    const controller = new AbortController();
    syncAbort.current = controller;
    const { apiBase, deviceToken } = deviceAuth;
    const options = { signal: controller.signal };

    const result = await runSync({
      signal: controller.signal,
      onProgress: setSyncProgress,
      api: {
        listDocumentPage: ({ cursor, limit }) => listDocumentPage(apiBase, deviceToken, { cursor, limit, ...options }),
        listFolders: () => listServerFolders(apiBase, deviceToken, options),
        fetchContent: (id) => fetchDocumentContent(apiBase, deviceToken, id, options),
        pushDocument: (doc) => pushDocument(apiBase, deviceToken, doc, options),
        pushFolder: (name) => pushFolder(apiBase, deviceToken, name, options),
      },
      store: {
        getDocs: getAllLocalDocuments,
        putDoc: saveDocumentLocally,
        deleteDoc: deleteLocalDocument,
        remapDoc: remapLocalDocumentId,
        getFolders: getAllLocalFolders,
        putFolder: saveLocalFolder,
        deleteFolder: deleteLocalFolder,
      },
    });

    await loadDocuments();
    setSyncFailures(result.failures);
    if (result.status === 'revoked') {
      setRevokedNotice(result.message);
    } else if (result.status === 'offline') {
      setSyncError(
        "You're offline, or the server can't be reached right now. What is already on this phone still works; try Sync again when you're back online."
      );
    } else if (result.status === 'outdated') {
      setSyncError(result.message);
    } else if (result.status === 'cancelled') {
      setSyncMessage('Sync stopped. Nothing is lost: the next sync carries on from where this one got to.');
    } else {
      const parts = [`pulled ${result.pulled}`, `pushed ${result.pushed}`, `removed ${result.removed}`];
      if (result.updated > 0) parts.push(`updated ${result.updated}`);
      setSyncMessage(
        result.status === 'partial' ? `Synced with problems: ${parts.join(', ')}.` : `Synced: ${parts.join(', ')}.`
      );
      updateDeviceAuth(deviceAuth.deviceId, { lastSyncAt: new Date().toISOString() }).catch(() => {});
    }
    syncAbort.current = null;
    setSyncProgress(null);
    setSyncing(false);
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

  // The phone creates folders locally (pushed on the next sync), so it
  // checks the same rule the server enforces - same parent, compared
  // trimmed and case-insensitively - instead of letting "josh" sit next to
  // "Josh" until a sync quietly merges them.
  const createLocalFolder = async (fullPath) => {
    const key = fullPath.trim().toLowerCase();
    // Every known path plus all of its ancestors - a folder only implied by
    // a deeper path ("Josh" from "Josh/2024") counts too.
    const known = new Set();
    for (const path of [
      ...documents.map((doc) => normalizeFolderPath(doc.folder)),
      ...localFolders.map((record) => normalizeFolderPath(record.name)),
    ]) {
      const parts = splitPath(path);
      for (let index = 1; index <= parts.length; index += 1) known.add(joinPath(parts.slice(0, index)));
    }
    const existing = [...known].find((path) => path.toLowerCase() === key);
    if (existing) {
      throw new Error(`A folder named "${existing.split('/').pop()}" already exists here.`);
    }
    await saveLocalFolder({ name: fullPath, syncStatus: 'pending' });
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
              Pair this phone with your vault first - on your computer, open Devices, choose "Pair a phone" and scan
              the QR code with this phone.
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
                  inputMode="text"
                  className={styles.textInput}
                  value={pin}
                  onChange={(event) => {
                    setPin(event.target.value);
                    setPinError('');
                  }}
                  placeholder="Enter your PIN"
                  autoFocus
                  autoComplete="off"
                  disabled={lockout.waitMs > 0}
                />
                {pinError && <p className={styles.fieldError} role="alert">{pinError}</p>}
                {lockout.waitMs > 0 && (
                  <p className={styles.fieldError} role="status">
                    Too many wrong PINs. Wait {describeWait(lockout.waitMs)} before trying again.
                  </p>
                )}
                {lockout.failures > 0 && lockout.waitMs <= 0 && !pinError && (
                  <p className={styles.hint}>
                    {lockout.triesLeft} {lockout.triesLeft === 1 ? 'try' : 'tries'} left before this phone locks.
                  </p>
                )}
              </div>

              <button type="submit" className={styles.submitButton} disabled={unlocking || !pin || lockout.waitMs > 0}>
                <span>{unlocking ? 'Unlocking...' : 'Unlock'}</span>
                <ArrowRight size={18} weight="bold" />
              </button>
            </form>
          </div>
        )}

        {phase === 'locked-out' && (
          <div className={styles.formPanel}>
            <div className={styles.copy}>
              <h1 className={styles.title}>This phone is locked</h1>
              <p className={styles.subtitle}>
                The PIN was wrong 10 times. To use Warden on this phone again, remove its copy here and pair it again from your computer
                (Devices, then Pair a phone). Your files are safe on your account.
              </p>
            </div>
            <p className={styles.hint}>Anything added on this phone that has not been synced yet will be lost.</p>
            <button type="button" className={styles.submitButton} onClick={() => setResetOpen(true)}>
              <span>Remove this phone’s copy</span>
            </button>
          </div>
        )}

        {phase === 'new-pin' && (
          <div className={styles.formPanel}>
            <div className={styles.copy}>
              <h1 className={styles.title}>Choose a new PIN</h1>
              <p className={styles.subtitle}>
                {newPinReason === 'weak-pin'
                  ? 'The PIN you just used is shorter or easier to guess than the new rules allow (at least 6 characters, nothing obvious like 123456).'
                  : 'Warden now protects the key on this phone more strongly. Choose a new PIN of at least 6 characters, and not an obvious one.'}
              </p>
            </div>
            <form className={styles.form} onSubmit={handleSetNewPin} noValidate>
              <div className={styles.field}>
                <label htmlFor="new-pin" className={styles.fieldLabel}>New PIN</label>
                <input
                  id="new-pin"
                  type="password"
                  className={styles.textInput}
                  value={newPin}
                  onChange={(event) => {
                    setNewPin(event.target.value);
                    setNewPinError('');
                  }}
                  placeholder="At least 6 characters"
                  autoFocus
                  autoComplete="off"
                  aria-describedby="new-pin-hint"
                />
                <p id="new-pin-hint" className={newPinCheck.message ? styles.fieldError : styles.hint} data-strength={newPinCheck.strength} role="status">
                  {newPin.length === 0 || newPinCheck.ok ? newPinCheck.hint : newPinCheck.message}
                </p>
              </div>
              <div className={styles.field}>
                <label htmlFor="new-pin-confirm" className={styles.fieldLabel}>Confirm new PIN</label>
                <input
                  id="new-pin-confirm"
                  type="password"
                  className={styles.textInput}
                  value={newPinConfirm}
                  onChange={(event) => {
                    setNewPinConfirm(event.target.value);
                    setNewPinError('');
                  }}
                  placeholder="Re-enter the new PIN"
                  autoComplete="off"
                />
                {newPinError && <p className={styles.fieldError} role="alert">{newPinError}</p>}
              </div>
              <button type="submit" className={styles.submitButton} disabled={savingPin || !newPinCheck.ok || newPin !== newPinConfirm}>
                <span>{savingPin ? 'Saving…' : 'Save the new PIN'}</span>
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
                {syncing ? (
                  <button type="button" className={styles.syncButton} onClick={() => syncAbort.current?.abort()}>
                    Stop sync
                  </button>
                ) : (
                  <button type="button" className={styles.syncButton} onClick={handleSync}>
                    Sync now
                  </button>
                )}
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

            {!online && (
              <p className={styles.offlineNote} role="status">
                You’re offline. Everything already on this phone still opens; changes sync when you’re back online.
              </p>
            )}
            {revokedNotice && (
              <div className={styles.revokedBox} role="alert">
                <p>{revokedNotice}</p>
                <p className={styles.hint}>
                  The files already on this phone stay readable with your PIN until you remove this phone’s copy.
                </p>
                <button type="button" className={styles.syncButton} onClick={() => setResetOpen(true)}>
                  Remove this phone’s copy
                </button>
              </div>
            )}
            {syncing && syncProgress && (
              <div className={styles.progressBlock} role="status" aria-live="polite">
                <p className={styles.syncMessage}>{progressText(syncProgress)}</p>
                {syncProgress.total > 0 && syncProgress.phase !== 'listing' && (
                  <progress className={styles.bar} max={syncProgress.total} value={syncProgress.done} aria-label="Sync progress" />
                )}
              </div>
            )}
            {syncMessage && <p className={styles.syncMessage}>{syncMessage}</p>}
            {syncError && <p className={styles.fieldError} role="alert">{syncError}</p>}
            {syncFailures.length > 0 && (
              <ul className={styles.failureList}>
                {syncFailures.map((failure, index) => (
                  <li key={`${failure.name}-${index}`}>
                    <strong>{failure.name}</strong> - {failure.reason}
                  </li>
                ))}
              </ul>
            )}
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

      {resetOpen && (
        <Modal title="Remove this phone’s copy?" onClose={() => setResetOpen(false)}>
          <p className={styles.confirmText}>
            This deletes the encrypted files stored on this phone and signs it out of your account. Files that were never synced
            will be lost. You can pair the phone again from your computer’s Devices page.
          </p>
          <div className={styles.confirmButtons}>
            <button type="button" className={styles.viewButton} onClick={() => setResetOpen(false)}>
              Cancel
            </button>
            <button type="button" className={styles.confirmYes} onClick={handleResetDevice}>
              Remove it
            </button>
          </div>
        </Modal>
      )}

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
          createFolderFn={createLocalFolder}
        />
      )}
    </div>
  );
}

export default PhoneVault;
