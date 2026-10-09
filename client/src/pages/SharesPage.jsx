import { useCallback, useEffect, useState } from 'react';

import Icon from '../components/site/Icon.jsx';
import ShareEditModal from '../components/ShareEditModal.jsx';
import { listAllShares, revokeShareById, stopAllShares } from '../services/sharesService.js';
import { extractErrorMessage } from '../services/api.js';
import { formatDateTime } from '../utils/formatDate.js';
import { usePageMeta } from '../utils/usePageMeta.js';
import site from '../components/site/site.module.css';
import forms from '../components/site/forms.module.css';
import auth from './auth/auth.module.css';
import styles from './SharesPage.module.css';
import pageStyles from './FilePages.module.css';

const MB = 1024 * 1024;
const formatMb = (bytes) => `${bytes < 10 * MB ? (bytes / MB).toFixed(1) : Math.round(bytes / MB)}MB`;

function describeExpiry(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'Expired';
  const hours = ms / 3600000;
  if (hours < 1) return `in ${Math.max(1, Math.round(ms / 60000))} min`;
  if (hours < 48) return `in ${Math.round(hours)} h`;
  return `in ${Math.round(hours / 24)} days`;
}

/**
 * The share manager: every active share of this account. Names are the shared
 * files' names, decrypted by the server for this signed-in session only. We do
 * NOT keep share links or keys, so nothing here can show or recover a link -
 * a link exists only where it was copied at creation.
 */
function SharesPage() {
  usePageMeta('Shared', 'The links you have shared.');
  const [shares, setShares] = useState(null);
  const [usage, setUsage] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [confirming, setConfirming] = useState(null); // share id, or 'all'
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await listAllShares();
      setShares(data.shares);
      setUsage(data.usage);
      setError('');
      return data.shares;
    } catch (err) {
      setError(extractErrorMessage(err, 'We couldn’t load your shares.'));
      setShares((current) => current ?? []);
      return null;
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // The edit dialog shows the live version of the share it is editing.
  const editingShare = editing ? shares?.find((share) => share.id === editing) : null;

  const stopOne = async (id) => {
    if (confirming !== id) {
      setConfirming(id);
      return;
    }
    setBusy(true);
    try {
      await revokeShareById(id);
      setConfirming(null);
      await load();
    } catch (err) {
      setError(extractErrorMessage(err, 'We couldn’t stop that share.'));
    } finally {
      setBusy(false);
    }
  };

  const stopEverything = async () => {
    if (confirming !== 'all') {
      setConfirming('all');
      return;
    }
    setBusy(true);
    try {
      await stopAllShares();
      setConfirming(null);
      await load();
    } catch (err) {
      setError(extractErrorMessage(err, 'We couldn’t stop sharing.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={pageStyles.page}>
      <div className={auth.stack}>
        <div className={pageStyles.toolbar}>
          <div className={pageStyles.titleBlock}>
            <h1 className={pageStyles.heading}>Shared</h1>
            <span className={pageStyles.count}>
              {shares === null ? 'Loading…' : `${shares.length} active link${shares.length === 1 ? '' : 's'}`}
            </span>
          </div>
        </div>
        <p className={forms.hint}>
          Everything you are sharing right now. We don’t keep your links or their keys, so a link can’t be shown again:
          copy it when you create it.
        </p>

        {error && (
          <div className={forms.alert} role="alert">
            <Icon name="alert" />
            <p>{error}</p>
          </div>
        )}

        {usage && (
          <p className={forms.hint} data-testid="shares-usage">
            {usage.activeShares} of {usage.maxActiveShares} shares, {formatMb(usage.usedBytes)} of {formatMb(usage.limitBytes)} shared storage used.
          </p>
        )}

        {shares === null && <p className={forms.hint}>Loading…</p>}

        {shares && shares.length === 0 && (
          <p className={styles.empty}>You aren&apos;t sharing anything. Use Share on a file in My files or Photos to make a link.</p>
        )}

        {shares && shares.length > 0 && (
          <>
            <ul className={styles.list}>
              {shares.map((share) => (
                <li key={share.id} className={styles.card} data-testid="share-card">
                  <div className={styles.cardHead}>
                    <h2 className={styles.name}>{share.name}</h2>
                    <p className={styles.meta}>
                      {share.fileCount} item{share.fileCount === 1 ? '' : 's'} · {formatMb(share.totalBytes)}
                    </p>
                    {share.purpose && (
                      <p className={styles.meta} data-testid="share-purpose">
                        Purpose: {share.purpose}
                      </p>
                    )}
                  </div>

                  <dl className={styles.facts}>
                    <div>
                      <dt>Created</dt>
                      <dd>{formatDateTime(share.createdAt)}</dd>
                    </div>
                    <div>
                      <dt>Expires</dt>
                      <dd title={formatDateTime(share.expiresAt)}>
                        {describeExpiry(share.expiresAt)} <span className={styles.faint}>({formatDateTime(share.expiresAt)})</span>
                      </dd>
                    </div>
                    <div>
                      <dt>Downloads</dt>
                      <dd data-testid="share-downloads">
                        {share.downloadCount}
                        {share.maxDownloads ? ` of ${share.maxDownloads}` : ''}
                      </dd>
                    </div>
                  </dl>

                  <div className={styles.chips}>
                    <span className={`${styles.chip} ${share.passwordProtected ? styles.chipOn : ''}`}>
                      Password {share.passwordProtected ? 'on' : 'off'}
                    </span>
                    <span className={`${styles.chip} ${share.emailRestricted ? styles.chipOn : ''}`}>
                      Email-restricted {share.emailRestricted ? 'on' : 'off'}
                    </span>
                    {share.emailRestricted && <span className={styles.faint}>{share.recipientEmail}</span>}
                  </div>

                  <div className={styles.actions}>
                    <button type="button" className={`${site.button} ${site.ghost}`} onClick={() => setEditing(share.id)} disabled={busy}>
                      Edit…
                    </button>
                    <button
                      type="button"
                      className={confirming === share.id ? styles.danger : `${site.button} ${site.ghost}`}
                      onClick={() => stopOne(share.id)}
                      disabled={busy}
                    >
                      {confirming === share.id ? 'Confirm: stop sharing' : 'Stop sharing'}
                    </button>
                    {confirming === share.id && (
                      <button type="button" className={auth.inlineLink} onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            <div className={styles.stopAll}>
              <button
                type="button"
                className={confirming === 'all' ? styles.danger : `${site.button} ${site.ghost}`}
                onClick={stopEverything}
                disabled={busy}
              >
                {confirming === 'all' ? `Confirm: delete all ${shares.length} shares` : 'Stop all sharing'}
              </button>
              {confirming === 'all' && (
                <button type="button" className={auth.inlineLink} onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              )}
              <p className={forms.hint}>Deletes every share and its encrypted copies at once. Your documents are not touched.</p>
            </div>
          </>
        )}
      </div>

      {editingShare && <ShareEditModal share={editingShare} onClose={() => setEditing(null)} onChanged={load} />}
    </div>
  );
}

export default SharesPage;
