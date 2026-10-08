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
  setSharePassword,
} from '../services/sharesService.js';
import { base64UrlToBytes } from '../utils/shareCrypto.js';
import { KDF_PARAMS, deriveShareSecrets, passwordProblem, randomSalt, toBase64, wrapShareKey } from '../utils/sharePassword.js';
import { extractErrorMessage } from '../services/api.js';
import { formatDateTime } from '../utils/formatDate.js';
import { DEFAULT_EXPIRY_DAYS, EXPIRY_PRESET_DAYS, MAX_EXPIRY_DAYS, customDaysProblem, dayLabel, daysToHours } from '../utils/shareExpiry.js';
import styles from './ShareModal.module.css';


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
  const [durationDays, setDurationDays] = useState(DEFAULT_EXPIRY_DAYS);
  const [isCustomExpiry, setIsCustomExpiry] = useState(false);
  const [customExpiry, setCustomExpiry] = useState('');
  const [creating, setCreating] = useState(false);
  const [createStatus, setCreateStatus] = useState('');
  const [createError, setCreateError] = useState('');
  // Optional protections (all off by default).
  const [password, setPassword] = useState('');
  const [maxDownloadsText, setMaxDownloadsText] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
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

  // The endpoint takes durationHours (an offset from now); the interface only
  // ever offers whole days (utils/shareExpiry.js), converted here.
  const customDaysMessage = isCustomExpiry ? customDaysProblem(customExpiry) : '';
  const isCustomExpiryValid = isCustomExpiry && customDaysMessage === '';
  const maxDownloadsValue = maxDownloadsText.trim() === '' ? null : Number(maxDownloadsText);
  const maxDownloadsProblem =
    maxDownloadsValue !== null && (!Number.isInteger(maxDownloadsValue) || maxDownloadsValue < 1 || maxDownloadsValue > 100)
      ? 'Enter a whole number from 1 to 100, or leave it empty for no limit.'
      : '';
  const emailProblem =
    recipientEmail.trim() !== '' && !/^[^\s@,;<>()[\]"]+@[^\s@,;<>()[\]"]+\.[^\s@,;<>()[\]"]+$/.test(recipientEmail.trim())
      ? 'Enter one email address.'
      : '';
  const pwProblem = password !== '' ? passwordProblem(password) : '';
  const canGenerate =
    !creating &&
    (!isCustomExpiry || isCustomExpiryValid) &&
    !maxDownloadsProblem &&
    !emailProblem &&
    !pwProblem;

  const handlePresetClick = (days) => {
    setIsCustomExpiry(false);
    setDurationDays(days);
  };

  const handleCustomClick = () => {
    setIsCustomExpiry(true);
  };

  const handleGenerate = async () => {
    if (!canGenerate) return;
    setCreating(true);
    setCreateError('');
    try {
      const hours = daysToHours(isCustomExpiry ? Number(customExpiry.trim()) : durationDays);
      const options = {};
      if (maxDownloadsValue !== null) options.maxDownloads = maxDownloadsValue;
      if (recipientEmail.trim()) options.recipientEmail = recipientEmail.trim();
      if (password) options.passwordProtected = true;
      const result = isSingle
        ? await createShare(documentId, hours, options)
        : await createBulkShare(documentIds, hours, options);

      // A password share: the server made the key and returned it in the link,
      // hidden until now. THIS browser locks that key under the password
      // (scrypt, in the browser; the password never leaves it), sends only the
      // wrapped key, and shows a link WITHOUT the key. If anything fails the
      // hidden share is deleted.
      let shareUrl = result.shareUrl;
      if (result.passwordPending) {
        setCreateStatus('Locking the link with your password…');
        try {
          const keyText = new URL(result.shareUrl).hash.slice(3);
          const salt = randomSalt();
          const { wrapKey, verifier } = await deriveShareSecrets(password, salt);
          const wrappedKey = await wrapShareKey(base64UrlToBytes(keyText), wrapKey, result.id);
          await setSharePassword(result.id, { salt: toBase64(salt), kdf: KDF_PARAMS, wrappedKey, verifier });
          const clean = new URL(result.shareUrl);
          clean.hash = '';
          shareUrl = clean.toString();
        } catch (err) {
          await revokeShareById(result.id).catch(() => {});
          throw err;
        }
      }
      // result.shareUrl is built server-side from PUBLIC_APP_URL (or, in
      // development only, the PC's LAN address), never from this tab's own
      // address. Its #fragment is the share's key: it appears here, once,
      // and nowhere on the server. The localhost variant below is only a
      // same-machine convenience for the dev LAN-IP case, where localhost
      // is a secure context with no certificate warning.
      const localUrl = new URL(shareUrl);
      const devLanLink = /^\d+\.\d+\.\d+\.\d+$/.test(localUrl.hostname);
      localUrl.hostname = 'localhost';

      setCreatedShare({
        ...result,
        shareUrl,
        passwordProtected: Boolean(result.passwordPending),
        localShareUrl: devLanLink ? localUrl.toString() : null,
      });
      setPassword('');
      if (result.usage) setUsage(result.usage);
      setCopied(false);
      setBulkRevoked(false);
      setConfirmingBulkRevoke(false);
      refreshShares();
    } catch (err) {
      setCreateError(extractErrorMessage(err, 'Could not generate a share link.'));
    } finally {
      setCreating(false);
      setCreateStatus('');
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
              {EXPIRY_PRESET_DAYS.map((days) => (
                <button
                  key={days}
                  type="button"
                  className={`${styles.presetButton} ${!isCustomExpiry && durationDays === days ? styles.presetActive : ''}`}
                  onClick={() => handlePresetClick(days)}
                  aria-pressed={!isCustomExpiry && durationDays === days}
                  disabled={creating}
                >
                  {dayLabel(days)}
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
                  id="share-custom-days"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max={MAX_EXPIRY_DAYS}
                  step="1"
                  className={styles.textInput}
                  value={customExpiry}
                  onChange={(event) => setCustomExpiry(event.target.value)}
                  disabled={creating}
                  placeholder={`Days (1 to ${MAX_EXPIRY_DAYS})`}
                  aria-label={`Custom expiry in days, 1 to ${MAX_EXPIRY_DAYS}`}
                  aria-invalid={Boolean(customDaysMessage)}
                  aria-describedby="share-custom-days-error"
                />
                <p id="share-custom-days-error" className={styles.fieldError} aria-live="polite">
                  {customExpiry !== '' ? customDaysMessage : ''}
                </p>
              </div>
            )}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="share-password">
              Password (optional)
            </label>
            <input
              id="share-password"
              type="password"
              className={styles.textInput}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              disabled={creating}
              placeholder="No password"
              aria-invalid={Boolean(pwProblem)}
            />
            {pwProblem ? (
              <p className={styles.fieldError}>{pwProblem}</p>
            ) : (
              <p className={styles.hint}>
                Whoever opens the link must type it. Your browser uses it to lock the link&apos;s key, and the password
                itself never reaches us, so we can&apos;t reset it. Send it by a different route than the link.
              </p>
            )}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="share-max-downloads">
              Limit downloads (optional)
            </label>
            <input
              id="share-max-downloads"
              type="number"
              inputMode="numeric"
              min="1"
              max="100"
              step="1"
              className={styles.textInput}
              value={maxDownloadsText}
              onChange={(event) => setMaxDownloadsText(event.target.value)}
              disabled={creating}
              placeholder="No limit"
              aria-invalid={Boolean(maxDownloadsProblem)}
            />
            {maxDownloadsProblem ? (
              <p className={styles.fieldError}>{maxDownloadsProblem}</p>
            ) : (
              <p className={styles.hint}>
                After this many downloads (1 to 100) the share is deleted. Each file delivered to a viewer counts as one
                download, and a single-file link counts when it is opened.
              </p>
            )}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="share-recipient">
              Only this email address (optional)
            </label>
            <input
              id="share-recipient"
              type="email"
              className={styles.textInput}
              value={recipientEmail}
              onChange={(event) => setRecipientEmail(event.target.value)}
              disabled={creating}
              autoComplete="off"
              placeholder="Anyone with the link"
              aria-invalid={Boolean(emailProblem)}
            />
            {emailProblem ? (
              <p className={styles.fieldError}>{emailProblem}</p>
            ) : (
              <p className={styles.hint}>
                Before the server hands over anything, the viewer must enter a 6-digit code we email to this address. This
                controls who the server serves the encrypted copies to; the link itself is still a secret, so send it over
                a trusted channel.
              </p>
            )}
          </div>

          <p className={styles.error} role="alert">
            {createError || ' '}
          </p>

          <button type="button" className={styles.generateButton} onClick={handleGenerate} disabled={!canGenerate}>
            {creating ? createStatus || 'Generating...' : 'Generate share link'}
          </button>
          {usage && (
            <p className={styles.hint} data-testid="share-usage">
              Shared storage: {formatMb(usage.usedBytes)} of {formatMb(usage.limitBytes)} used,{' '}
              {formatMb(usage.remainingBytes)} left. One share holds up to {formatMb(usage.perShareLimitBytes)};
              you can have {usage.maxActiveShares} active shares ({usage.activeShares} now).
            </p>
          )}
          <p className={styles.demoNote}>
            A share link contains a key after the # symbol (or, with a password, the key is locked by the password
            instead). Anyone who has the full link, and any password or code you required, can open the shared files
            until it expires or you revoke it. The server stores only encrypted copies of the shared files and never
            stores the link&apos;s key. You can&apos;t get the link back later, so copy it when it appears. A share is a
            snapshot: deleting or editing the original file does not change or remove existing shared copies; stop
            sharing to remove them.
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
              {createdShare.passwordProtected
                ? 'This link has no key in it: whoever opens it needs the password you chose, and your browser locked the key with it. We never see the password and can’t reset it, so tell recipients the password by a different route. '
                : 'Copy the whole link, including everything after the # - that part is the key, and this is the only time you will see it. '}
              Anyone who has the full link{createdShare.passwordProtected ? ', the password' : ''}
              {createdShare.recipientEmail ? ' and a code emailed to the recipient' : ''} can open the shared files until it
              expires or you stop sharing.
              {createdShare.maxDownloads ? ` It is deleted after ${createdShare.maxDownloads} download${createdShare.maxDownloads === 1 ? '' : 's'}.` : ''}
              {' '}You can&apos;t get the link back later: we don&apos;t keep it. The QR code below encodes the same link.
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
                <span className={styles.shareExpiry}>
                  {describeExpiry(share.expiresAt)}
                  {share.passwordProtected ? ' · password' : ''}
                  {share.emailRestricted ? ' · email only' : ''}
                  {share.maxDownloads ? ` · ${share.downloadCount}/${share.maxDownloads} downloads` : share.downloadCount ? ` · ${share.downloadCount} downloads` : ''}
                </span>

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
