import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, Trash } from '@phosphor-icons/react';

import Modal from './Modal.jsx';
import {
  createShare,
  createBulkShare,
  listShares,
  fetchShareUsage,
  revokeShareById,
} from '../services/sharesService.js';
import { extractErrorMessage } from '../services/api.js';
import { formatDateTime } from '../utils/formatDate.js';
import { getNowDateTimeInputValue } from '../utils/dateInputs.js';
import styles from './ShareModal.module.css';

const DURATION_PRESETS = [
  { label: '1 hour', hours: 1 },
  { label: '24 hours', hours: 24 },
  { label: '3 days', hours: 72 },
  { label: '7 days', hours: 168 },
];
const DEFAULT_PRESET = DURATION_PRESETS[3]; // 7 days
const MAX_EXPIRY_DAYS = 30; // the server's cap too

const MB = 1024 * 1024;
function formatMb(bytes) {
  const value = bytes / MB;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}MB`;
}

/**
 * Plain-language countdown from an ISO expiresAt, used both for a
 * freshly-generated link and for entries in the active-shares list -
 * computed live from the timestamp rather than the duration preset that
 * was picked, since the list endpoint only ever returns expiresAt.
 */
function describeExpiry(expiresAtIso) {
  const ms = new Date(expiresAtIso).getTime() - Date.now();
  if (ms <= 0) return 'Expired';

  const hours = ms / (60 * 60 * 1000);
  if (hours < 1) {
    const minutes = Math.max(1, Math.round(ms / 60000));
    return `Expires in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  if (hours < 48) {
    const roundedHours = Math.round(hours);
    return `Expires in ${roundedHours} hour${roundedHours === 1 ? '' : 's'}`;
  }
  const days = Math.round(hours / 24);
  return `Expires in ${days} day${days === 1 ? '' : 's'}`;
}

/**
 * `documentIds` is the set this link will cover - one id (a single card's
 * Share button, unchanged behavior) or many (a folder selection resolved to
 * its nested documents plus loose files, all under ONE link). The
 * per-document "Active shares" list only exists for the single case; a
 * multi-file link is revoked right from its result view.
 */
function ShareModal({ documentIds, title, onClose }) {
  const isSingle = documentIds.length === 1;
  const documentId = documentIds[0];
  const [durationHours, setDurationHours] = useState(DEFAULT_PRESET.hours);
  const [isCustomExpiry, setIsCustomExpiry] = useState(false);
  const [customExpiry, setCustomExpiry] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createdShare, setCreatedShare] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [copied, setCopied] = useState(false);

  const [shares, setShares] = useState([]);
  const [sharesLoading, setSharesLoading] = useState(isSingle);
  const [sharesError, setSharesError] = useState('');
  const [confirmingRevokeId, setConfirmingRevokeId] = useState(null);
  const [revokingId, setRevokingId] = useState(null);

  const [bulkRevoked, setBulkRevoked] = useState(false);
  const [confirmingBulkRevoke, setConfirmingBulkRevoke] = useState(false);
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchShareUsage()
      .then((data) => {
        if (!cancelled) setUsage(data);
      })
      .catch(() => {
        // The line is informational; the server enforces the limits anyway.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshShares = useCallback(async () => {
    if (!isSingle) return;
    setSharesLoading(true);
    setSharesError('');
    try {
      const data = await listShares(documentId);
      setShares(data);
    } catch (err) {
      setSharesError(extractErrorMessage(err, 'Could not load active shares.'));
    } finally {
      setSharesLoading(false);
    }
  }, [documentId, isSingle]);

  useEffect(() => {
    refreshShares();
  }, [refreshShares]);

  // Renders the QR client-side (qrcode npm package) whenever a new share
  // link is generated - no backend involvement at all.
  useEffect(() => {
    if (!createdShare?.shareUrl) {
      setQrDataUrl(null);
      return undefined;
    }

    let cancelled = false;
    QRCode.toDataURL(createdShare.shareUrl, { margin: 1, width: 220 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [createdShare]);

  // The endpoint only ever takes durationHours (an offset from now) - a
  // custom expiry is just that same offset computed from the exact
  // datetime the owner picked, rather than a fixed preset. No backend
  // change needed, and fractional hours (e.g. 10 minutes = 1/6 hour) work
  // fine since the controller only requires a positive finite number.
  const customExpiryMs = isCustomExpiry && customExpiry ? new Date(customExpiry).getTime() : null;
  const isCustomExpiryValid =
    Number.isFinite(customExpiryMs) &&
    customExpiryMs > Date.now() &&
    customExpiryMs <= Date.now() + MAX_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  const canGenerate = !creating && (!isCustomExpiry || isCustomExpiryValid);

  const handlePresetClick = (hours) => {
    setIsCustomExpiry(false);
    setDurationHours(hours);
  };

  const handleCustomClick = () => {
    setIsCustomExpiry(true);
    if (!customExpiry) setCustomExpiry(getNowDateTimeInputValue());
  };

  const handleGenerate = async () => {
    if (!canGenerate) return;
    setCreating(true);
    setCreateError('');
    try {
      const hours = isCustomExpiry ? (customExpiryMs - Date.now()) / (60 * 60 * 1000) : durationHours;
      const result = isSingle
        ? await createShare(documentId, hours)
        : await createBulkShare(documentIds, hours);
      // result.shareUrl is built server-side from PUBLIC_APP_URL (or, in
      // development only, the PC's LAN address), never from this tab's own
      // address. Its #fragment is the share's key: it appears here, once,
      // and nowhere on the server. The localhost variant below is only a
      // same-machine convenience for the dev LAN-IP case, where localhost
      // is a secure context with no certificate warning.
      const localUrl = new URL(result.shareUrl);
      const devLanLink = /^\d+\.\d+\.\d+\.\d+$/.test(localUrl.hostname);
      localUrl.hostname = 'localhost';

      setCreatedShare({ ...result, localShareUrl: devLanLink ? localUrl.toString() : null });
      if (result.usage) setUsage(result.usage);
      setCopied(false);
      setBulkRevoked(false);
      setConfirmingBulkRevoke(false);
      refreshShares();
    } catch (err) {
      setCreateError(extractErrorMessage(err, 'Could not generate a share link.'));
    } finally {
      setCreating(false);
    }
  };

  const handleBulkRevoke = async () => {
    if (!confirmingBulkRevoke) {
      setConfirmingBulkRevoke(true);
      return;
    }
    setRevokingId(createdShare.id);
    setCreateError('');
    try {
      const revoked = await revokeShareById(createdShare.id);
      if (revoked?.usage) setUsage(revoked.usage);
      setBulkRevoked(true);
    } catch (err) {
      setCreateError(extractErrorMessage(err, 'Could not revoke this link.'));
    } finally {
      setRevokingId(null);
      setConfirmingBulkRevoke(false);
    }
  };

  const handleGenerateAnother = () => {
    setCreatedShare(null);
    setCreateError('');
    setIsCustomExpiry(false);
    setCustomExpiry('');
  };

  const handleCopy = async () => {
    if (!createdShare?.shareUrl) return;
    try {
      await navigator.clipboard.writeText(createdShare.shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can fail (permissions, insecure context on some
      // browsers) - the link is still fully visible/selectable in the
      // text field below, so this isn't a hard failure.
    }
  };

  const handleRevokeClick = (shareId) => {
    if (confirmingRevokeId === shareId) {
      setConfirmingRevokeId(null);
      handleRevoke(shareId);
    } else {
      setConfirmingRevokeId(shareId);
    }
  };

  const handleRevoke = async (shareId) => {
    setRevokingId(shareId);
    setSharesError('');
    try {
      const revoked = await revokeShareById(shareId);
      if (revoked?.usage) setUsage(revoked.usage);
      setShares((prev) => prev.filter((share) => share.id !== shareId));
    } catch (err) {
      setSharesError(extractErrorMessage(err, 'Could not revoke this share.'));
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      {!createdShare ? (
        <div className={styles.generateSection}>
          <div className={styles.field}>
            <span className={styles.label}>Link expires after</span>
            <div className={styles.presetRow}>
              {DURATION_PRESETS.map((preset) => (
                <button
                  key={preset.hours}
                  type="button"
                  className={`${styles.presetButton} ${!isCustomExpiry && durationHours === preset.hours ? styles.presetActive : ''}`}
                  onClick={() => handlePresetClick(preset.hours)}
                  disabled={creating}
                >
                  {preset.label}
                </button>
              ))}
              <button
                type="button"
                className={`${styles.presetButton} ${isCustomExpiry ? styles.presetActive : ''}`}
                onClick={handleCustomClick}
                disabled={creating}
              >
                Custom
              </button>
            </div>

            {isCustomExpiry && (
              <div className={styles.customExpiryField}>
                <input
                  type="datetime-local"
                  className={styles.textInput}
                  value={customExpiry}
                  onChange={(event) => setCustomExpiry(event.target.value)}
                  min={getNowDateTimeInputValue()}
                  max={getNowDateTimeInputValue(MAX_EXPIRY_DAYS * 24 * 60 * 60 * 1000)}
                  disabled={creating}
                  aria-label="Custom expiry date and time"
                />
                {customExpiry && !isCustomExpiryValid && (
                  <p className={styles.fieldError}>
                    Pick a date and time in the future, within {MAX_EXPIRY_DAYS} days.
                  </p>
                )}
              </div>
            )}
          </div>

          <p className={styles.error} role="alert">
            {createError || ' '}
          </p>

          <button type="button" className={styles.generateButton} onClick={handleGenerate} disabled={!canGenerate}>
            {creating ? 'Generating...' : 'Generate share link'}
          </button>
          {usage && (
            <p className={styles.hint} data-testid="share-usage">
              Shared storage: {formatMb(usage.usedBytes)} of {formatMb(usage.limitBytes)} used,{' '}
              {formatMb(usage.remainingBytes)} left. One share holds up to {formatMb(usage.perShareLimitBytes)};
              you can have {usage.maxActiveShares} active shares ({usage.activeShares} now).
            </p>
          )}
          <p className={styles.demoNote}>
            A share link contains a key after the # symbol. Anyone who has the full link can open the shared
            files until it expires or you revoke it. The server stores only encrypted copies of the shared files
            and never stores the link&apos;s key. A share is a snapshot: deleting or editing the original file
            does not change or remove existing shared copies; revoke the share to remove them.
          </p>
        </div>
      ) : (
        <div className={styles.resultSection}>
          <div className={styles.field}>
            <span className={styles.label}>Share link</span>
            <div className={styles.linkRow}>
              <input
                type="text"
                className={styles.linkInput}
                value={createdShare.shareUrl}
                readOnly
                onFocus={(event) => event.target.select()}
              />
              <button type="button" className={styles.copyButton} onClick={handleCopy}>
                {copied ? <Check size={16} weight="bold" /> : <Copy size={16} weight="bold" />}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            <p className={styles.hint}>
              Copy the whole link, including everything after the # - that part is the key, and this is the
              only time you will see it. Anyone who has the full link can open the shared files until it
              expires or you revoke it. The QR code below encodes the same link.
            </p>
          </div>

          {qrDataUrl && (
            <div className={styles.qrWrap}>
              <img src={qrDataUrl} alt="QR code for the share link" className={styles.qrImage} />
            </div>
          )}

          <p className={styles.expiryLine}>
            {describeExpiry(createdShare.expiresAt)}, at {formatDateTime(createdShare.expiresAt)}
          </p>

          {createdShare.localShareUrl && (
            <div className={styles.localLinkField}>
              <span className={styles.hint}>
                Open on this PC:{' '}
                <a
                  href={createdShare.localShareUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.localLink}
                >
                  {createdShare.localShareUrl}
                </a>
              </span>
            </div>
          )}

          {!isSingle && (
            <div className={styles.confirmRow}>
              {bulkRevoked ? (
                <span className={styles.confirmLabel}>
                  Link revoked - all {createdShare.entryCount} files are now inaccessible.
                </span>
              ) : (
                <>
                  <span className={styles.hint}>
                    This one link covers {createdShare.entryCount} files.
                  </span>
                  <button
                    type="button"
                    className={confirmingBulkRevoke ? styles.confirmYes : styles.secondaryButton}
                    onClick={handleBulkRevoke}
                    disabled={revokingId === createdShare.id}
                  >
                    {confirmingBulkRevoke ? 'Confirm revoke' : 'Revoke link'}
                  </button>
                </>
              )}
            </div>
          )}

          <button type="button" className={styles.secondaryButton} onClick={handleGenerateAnother}>
            Generate another link
          </button>
        </div>
      )}

      {isSingle && (
      <div className={styles.activeShares}>
        <span className={styles.label}>Active shares</span>

        {sharesLoading && <p className={styles.hint}>Loading...</p>}

        {!sharesLoading && sharesError && (
          <p className={styles.error} role="alert">
            {sharesError}
          </p>
        )}

        {!sharesLoading && !sharesError && shares.length === 0 && (
          <p className={styles.hint}>No active share links for this document.</p>
        )}

        {!sharesLoading && shares.length > 0 && (
          <ul className={styles.shareList}>
            {shares.map((share) => (
              <li key={share.id} className={styles.shareRow}>
                <span className={styles.shareExpiry}>{describeExpiry(share.expiresAt)}</span>

                {confirmingRevokeId !== share.id ? (
                  <button
                    type="button"
                    className={styles.revokeButton}
                    onClick={() => handleRevokeClick(share.id)}
                    aria-label="Revoke this share link"
                  >
                    <Trash size={14} />
                  </button>
                ) : (
                  <div className={styles.confirmRow}>
                    <span className={styles.confirmLabel}>Revoke?</span>
                    <button
                      type="button"
                      className={styles.confirmYes}
                      onClick={() => handleRevokeClick(share.id)}
                      disabled={revokingId === share.id}
                    >
                      {revokingId === share.id ? 'Revoking...' : 'Confirm'}
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
      )}
    </Modal>
  );
}

export default ShareModal;
