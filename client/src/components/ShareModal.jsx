import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, Trash } from '@phosphor-icons/react';

import Modal from './Modal.jsx';
import { createShare, listShares, revokeShareById } from '../services/sharesService.js';
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

function ShareModal({ documentId, filename, onClose }) {
  const [durationHours, setDurationHours] = useState(DURATION_PRESETS[1].hours);
  const [isCustomExpiry, setIsCustomExpiry] = useState(false);
  const [customExpiry, setCustomExpiry] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createdShare, setCreatedShare] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [copied, setCopied] = useState(false);

  const [shares, setShares] = useState([]);
  const [sharesLoading, setSharesLoading] = useState(true);
  const [sharesError, setSharesError] = useState('');
  const [confirmingRevokeId, setConfirmingRevokeId] = useState(null);
  const [revokingId, setRevokingId] = useState(null);

  const refreshShares = useCallback(async () => {
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
  }, [documentId]);

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
  const isCustomExpiryValid = Number.isFinite(customExpiryMs) && customExpiryMs > Date.now();
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
      const result = await createShare(documentId, hours);
      // result.shareUrl is now built server-side from the PC's actual
      // LAN-reachable address (same resolveLanIp helper pairing uses),
      // not window.location.origin - the owner's own tab is often on
      // "localhost", which means nothing to whoever they send this link
      // to. The localhost variant below is deliberately derived from
      // that same URL (same token, just a different hostname) purely as
      // a same-machine convenience for the owner: localhost is always a
      // secure context with no cert warnings, unlike the LAN IP.
      const localUrl = new URL(result.shareUrl);
      localUrl.hostname = 'localhost';

      setCreatedShare({ ...result, localShareUrl: localUrl.toString() });
      setCopied(false);
      refreshShares();
    } catch (err) {
      setCreateError(extractErrorMessage(err, 'Could not generate a share link.'));
    } finally {
      setCreating(false);
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
      await revokeShareById(shareId);
      setShares((prev) => prev.filter((share) => share.id !== shareId));
    } catch (err) {
      setSharesError(extractErrorMessage(err, 'Could not revoke this share.'));
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <Modal title={`Share "${filename}"`} onClose={onClose}>
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
                  disabled={creating}
                  aria-label="Custom expiry date and time"
                />
                {customExpiry && !isCustomExpiryValid && (
                  <p className={styles.fieldError}>Pick a date and time in the future.</p>
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
        </div>
      ) : (
        <div className={styles.resultSection}>
          <div className={styles.field}>
            <span className={styles.label}>Network link</span>
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
              Works from a phone or any other device on your network - this is what the QR code
              below encodes.
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

          <button type="button" className={styles.secondaryButton} onClick={handleGenerateAnother}>
            Generate another link
          </button>
        </div>
      )}

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
    </Modal>
  );
}

export default ShareModal;
