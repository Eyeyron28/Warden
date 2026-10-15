import { useCallback, useEffect, useRef, useState } from 'react';
import { Trash } from '@phosphor-icons/react';

import Modal from './Modal.jsx';
import ShareActions from './ShareActions.jsx';
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
import { useMediaQuery } from '../utils/useMediaQuery.js';
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
  const wide = useMediaQuery('(min-width: 760px)');
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
  const [purpose, setPurpose] = useState('');
  const [createdShare, setCreatedShare] = useState(null);

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

  const generating = useRef(false);
  const handleGenerate = async () => {
    // Set before anything else: a second press in the same tick finds it taken (the disabled button is only the second line).
    if (!canGenerate || generating.current) return;
    generating.current = true;
    setCreating(true);
    setCreateError('');
    try {
      const hours = daysToHours(isCustomExpiry ? Number(customExpiry.trim()) : durationDays);
      const options = {};
      if (maxDownloadsValue !== null) options.maxDownloads = maxDownloadsValue;
      if (recipientEmail.trim()) options.recipientEmail = recipientEmail.trim();
      if (password) options.passwordProtected = true;
      if (purpose.trim()) options.purpose = purpose.trim();
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
      // result.shareUrl is built server-side from PUBLIC_APP_URL (in development only, from the local
      // dev address), never from this tab's own address. Its #fragment is the share's key: it appears
      // here, once, and nowhere on the server.
      setCreatedShare({
        ...result,
        purpose: purpose.trim() || null,
        shareUrl,
        passwordProtected: Boolean(result.passwordPending),
      });
      setPassword('');
      if (result.usage) setUsage(result.usage);
      setBulkRevoked(false);
      setConfirmingBulkRevoke(false);
      refreshShares();
    } catch (err) {
      setCreateError(extractErrorMessage(err, 'Could not generate a share link.'));
    } finally {
      generating.current = false;
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

  const settings = (
    <section className={styles.settingsCol} aria-labelledby="share-settings-title">
      <h3 id="share-settings-title" className={styles.colTitle}>
        Link settings
      </h3>

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
          <p className={styles.hint}>Whoever opens the link must type it. We can&apos;t reset it.</p>
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
          <p className={styles.hint}>After this many downloads (1 to 100) the share is deleted.</p>
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
          <p className={styles.hint}>The viewer must enter a 6-digit code we email to this address.</p>
        )}
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="share-purpose">
          Purpose (optional)
        </label>
        <input
          id="share-purpose"
          type="text"
          className={styles.textInput}
          value={purpose}
          onChange={(event) => setPurpose(event.target.value)}
          maxLength={60}
          disabled={creating}
          autoComplete="off"
          placeholder="For BDO account opening"
        />
        <p className={styles.hint}>Shown to the viewer and printed faintly on previews.</p>
      </div>

      <p className={styles.error} role="alert">
        {createError || ' '}
      </p>
    </section>
  );

  const linkBlock = (
    <section className={styles.linkCol} aria-labelledby="share-link-title">
      <h3 id="share-link-title" className={styles.colTitle}>
        Your link
      </h3>

      {createdShare ? (
        <div className={styles.resultSection}>
          <ShareActions
            link={createdShare.shareUrl}
            passwordProtected={createdShare.passwordProtected}
            recipientEmail={createdShare.recipientEmail || ''}
            showQr={wide}
          />
          <p className={styles.expiryLine}>
            {describeExpiry(createdShare.expiresAt)}, at {formatDateTime(createdShare.expiresAt)}
          </p>
          <p className={styles.hint}>
            {createdShare.passwordProtected
              ? 'The viewer needs your password (we can’t reset it). '
              : 'Copy all of it, including the part after the # (the key). It is not shown again. '}
            {createdShare.recipientEmail ? 'They also need an emailed code. ' : ''}
            {createdShare.maxDownloads
              ? `Deleted after ${createdShare.maxDownloads} download${createdShare.maxDownloads === 1 ? '' : 's'}. `
              : ''}
            {createdShare.purpose ? `Purpose: ${createdShare.purpose}` : ''}
          </p>

          {!isSingle && (
            <div className={styles.confirmRow}>
              {bulkRevoked ? (
                <span className={styles.confirmLabel}>Link revoked - all {createdShare.entryCount} files are now inaccessible.</span>
              ) : (
                <>
                  <span className={styles.hint}>This one link covers {createdShare.entryCount} files.</span>
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
        </div>
      ) : (
        <p className={styles.placeholder}>
          {creating
            ? createStatus || 'Generating your link…'
            : 'Choose the settings, then press Generate share link. The link, its QR code and the buttons to send it appear here. The link is shown once: copy it when it appears.'}
        </p>
      )}

      <details className={styles.activeShares}>
        <summary className={styles.summary}>
          {isSingle ? `Active shares${!sharesLoading && !sharesError ? ` (${shares.length})` : ''} and how sharing works` : 'How sharing works'}
        </summary>

        {isSingle && (
          <div className={styles.activeList}>
            <span className={styles.label}>Active shares</span>

          {sharesLoading && <p className={styles.hint}>Loading...</p>}

          {!sharesLoading && sharesError && (
            <p className={styles.error} role="alert">
              {sharesError}
            </p>
          )}

          {!sharesLoading && !sharesError && shares.length === 0 && <p className={styles.hint}>No active share links for this document.</p>}

          {!sharesLoading && shares.length > 0 && (
            <ul className={styles.shareList}>
              {shares.map((share) => (
                <li key={share.id} className={styles.shareRow}>
                  <span className={styles.shareExpiry}>
                    {describeExpiry(share.expiresAt)}
                    {share.passwordProtected ? ' · password' : ''}
                    {share.emailRestricted ? ' · email only' : ''}
                    {share.purpose ? ` · ${share.purpose}` : ''}
                    {share.maxDownloads ? ` · ${share.downloadCount}/${share.maxDownloads} downloads` : share.downloadCount ? ` · ${share.downloadCount} downloads` : ''}
                  </span>

                  {confirmingRevokeId !== share.id ? (
                    <button type="button" className={styles.revokeButton} onClick={() => handleRevokeClick(share.id)} aria-label="Revoke this share link">
                      <Trash size={14} />
                    </button>
                  ) : (
                    <div className={styles.confirmRow}>
                      <span className={styles.confirmLabel}>Revoke?</span>
                      <button type="button" className={styles.confirmYes} onClick={() => handleRevokeClick(share.id)} disabled={revokingId === share.id}>
                        {revokingId === share.id ? 'Revoking...' : 'Confirm'}
                      </button>
                      <button type="button" className={styles.confirmNo} onClick={() => setConfirmingRevokeId(null)}>
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

        <p className={styles.demoNote}>
          Whoever opens a link with a password must type it; your browser uses it to lock the link&apos;s key and it never reaches us.
          A download limit counts each file delivered, and a single-file link counts when it is opened. An email restriction controls
          who the server serves the encrypted copies to; the link itself is still a secret, so send it over a trusted channel.
          The purpose is kept inside the encrypted share, not in the link.</p>
        {usage && (
          <p className={styles.hint} data-testid="share-usage">
            Shared storage: {formatMb(usage.usedBytes)} of {formatMb(usage.limitBytes)} used, {formatMb(usage.remainingBytes)} left.
            One share holds up to {formatMb(usage.perShareLimitBytes)}; you can have {usage.maxActiveShares} active shares (
            {usage.activeShares} now).
          </p>
        )}
        <p className={styles.demoNote}>
          A share link contains a key after the # symbol (or, with a password, the key is locked by the password instead). Anyone
          who has the full link, and any password or code you required, can open the shared files until it expires or you revoke
          it. The key is generated when you create the link, so it isn&apos;t sent to our server when someone opens the link; the
          server does handle it while it creates the link, but it stores only encrypted copies of the shared files, not the key.
          You can&apos;t get the link back later, so copy it when it appears. A share is a snapshot: editing the original file
          does not change existing shared copies, but moving the original to Trash stops every share that includes it right away;
          stop sharing to remove copies yourself.
        </p>
      </details>
    </section>
  );

  const footer = (
    <>
      <button type="button" className={styles.secondaryButton} onClick={onClose}>
        Done
      </button>
      <button type="button" className={styles.generateButton} onClick={handleGenerate} disabled={!canGenerate}>
        {creating ? createStatus || 'Generating...' : createdShare ? 'Generate another link' : 'Generate share link'}
      </button>
    </>
  );

  return (
    <Modal title={title} onClose={onClose} size="share" footer={footer}>
      {/* Wide: settings on the left, the link on the right. A phone: the link first. The DOM follows the visual order. */}
      <div className={styles.layout}>
        {wide ? (
          <>
            {settings}
            {linkBlock}
          </>
        ) : (
          <>
            {linkBlock}
            {settings}
          </>
        )}
      </div>
    </Modal>
  );
}

export default ShareModal;
