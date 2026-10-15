import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Info, Star, X } from '@phosphor-icons/react';

import { getDocumentDetails, peekDocumentDetails } from '../services/documentsService.js';
import { extractErrorMessage } from '../services/api.js';
import { formatManila } from '../utils/activityText.js';
import { formatDate } from '../utils/formatDate.js';
import { formatBytes } from '../utils/listing.js';
import { useFocusTrap } from '../utils/useFocusTrap.js';
import DetailsNotes from './DetailsNotes.jsx';
import DetailsVersions, { UploadVersion } from './DetailsVersions.jsx';
import styles from './DetailsPanel.module.css';

// What each kind of activity is called in this short list (the full wording is on the Devices & activity page).
const ACTIVITY = {
  upload: 'Uploaded',
  view: 'Opened',
  download: 'Downloaded',
  rename: 'Renamed',
  move: 'Moved',
  restore: 'Restored from Trash',
  delete: 'Moved to Trash',
  expiry_set: 'Expiry date set',
  expiry_cleared: 'Expiry date removed',
  note_set: 'Note added',
  note_changed: 'Note changed',
  note_cleared: 'Note removed',
  version_created: 'New version uploaded',
  version_restored: 'Earlier version restored',
  version_deleted: 'Earlier version deleted',
};

const FINGERPRINT_HELP =
  'A short fingerprint of the file: the first 12 characters of its checksum. Two files with the same fingerprint have the same contents. It does not reveal anything about what is inside.';

const kindLabel = (details) => {
  const type = details.type && details.type !== 'none' ? details.type : null;
  return (type || details.mimeType || 'file').toUpperCase();
};

function Row({ label, children }) {
  return (
    <div className={styles.row}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * The details panel for one file: a drawer beside the page on a wide screen, a sheet rising from the bottom on a phone. One
 * request when it opens (kept in the page cache, which every write empties); nothing in it is a key, an IV or a storage path.
 * Loaded on demand, so it is not part of the main bundle.
 */
function DetailsPanel({ id, name, opener, starred, onToggleStar, onChanged, onClose }) {
  const ref = useRef(null);
  const [details, setDetails] = useState(() => peekDocumentDetails(id) ?? null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [help, setHelp] = useState(false);
  const [reload, setReload] = useState(0);

  useFocusTrap(ref, true, { opener: opener ?? 'mount' });

  useEffect(() => {
    let cancelled = false;
    setError('');
    getDocumentDetails(id)
      .then((data) => {
        if (!cancelled) setDetails(data);
      })
      .catch((err) => {
        if (!cancelled) setError(extractErrorMessage(err, 'Could not load the details.'));
      });
    return () => {
      cancelled = true;
    };
  }, [id, starred, reload]); // a changed star or file is a write: the cached answer is gone, so ask again

  // The file's contents changed (a new version, a restore, a deleted version): ask again, and tell the page.
  const changed = (kind) => {
    if (kind === 'file') setReload((value) => value + 1);
    onChanged?.({ id, kind });
  };

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(details.fingerprint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const days = details?.daysUntilExpiry;
  const expiry = !details?.expiresAt ? 'None' : `${formatDate(details.expiresAt)} (${days < 0 ? `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago` : days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} left`})`;

  return createPortal(
    <div className={styles.layer}>
      <div className={styles.scrim} onClick={onClose} aria-hidden="true" />
      <aside ref={ref} className={styles.panel} role="dialog" aria-modal="true" aria-label={`Details for ${name}`}>
        <header className={styles.head}>
          <Info size={20} aria-hidden="true" />
          <h2 className={styles.title} title={name}>
            {name}
          </h2>
          <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Close details">
            <X size={18} />
          </button>
        </header>

        <div className={styles.body}>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          {!details && !error && <p className={styles.muted}>Loading…</p>}
          {details && (
            <>
              <button type="button" className={styles.starRow} onClick={onToggleStar} aria-pressed={Boolean(starred)}>
                <Star size={18} weight={starred ? 'fill' : 'regular'} />
                {starred ? 'Starred' : 'Not starred'}
                <span className={styles.hint}>{starred ? 'Click to remove the star' : 'Click to star this file'}</span>
              </button>

              <UploadVersion id={id} name={name} onChanged={changed} />

              <dl className={styles.list}>
                <Row label="Type">{kindLabel(details)}</Row>
                <Row label="Size">{formatBytes(details.size)}</Row>
                <Row label="Folder">{details.folder && details.folder !== 'root' ? details.folder : 'My files'}</Row>
                <Row label="Created">{formatManila(details.createdAt)}</Row>
                <Row label="Modified">{formatManila(details.updatedAt)}</Row>
                <Row label="Expires on">{expiry}</Row>
                <Row label="Shared">
                  {details.shared.count === 0 ? (
                    'Not shared'
                  ) : (
                    <>
                      {details.shared.count} active link{details.shared.count === 1 ? '' : 's'}
                      <ul className={styles.inline}>
                        {details.shared.links.map((link, index) => (
                          <li key={`${link.expiresAt}-${index}`}>expires {formatDate(link.expiresAt)}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </Row>
                {details.purposes.length > 0 && <Row label="Purpose">{details.purposes.join(', ')}</Row>}
                <Row label="Fingerprint">
                  <span className={styles.fingerprint}>
                    <code>{details.fingerprint}</code>
                    <button type="button" className={styles.smallButton} onClick={copy} aria-label="Copy the fingerprint">
                      <Copy size={14} /> {copied ? 'Copied' : 'Copy'}
                    </button>
                    <button
                      type="button"
                      className={styles.smallButton}
                      onClick={() => setHelp((value) => !value)}
                      aria-expanded={help}
                      aria-controls="fingerprint-help"
                    >
                      What is this?
                    </button>
                  </span>
                  {help && (
                    <p id="fingerprint-help" role="note" className={styles.help}>
                      {FINGERPRINT_HELP}
                    </p>
                  )}
                </Row>
              </dl>

              <DetailsNotes
                id={id}
                note={details.note}
                onSaved={(note) => {
                  setDetails((current) => (current ? { ...current, note: note ?? null, hasNote: Boolean(note) } : current));
                  onChanged?.({ id, kind: 'note', hasNote: Boolean(note) });
                }}
              />

              <DetailsVersions id={id} versions={details.versions} limits={details.versionLimits} onChanged={changed} />

              <h3 className={styles.sub}>Latest activity</h3>
              {details.activity.length === 0 ? (
                <p className={styles.muted}>Nothing recorded in the last 30 days.</p>
              ) : (
                <ol className={styles.activity}>
                  {details.activity.map((entry, index) => (
                    <li key={`${entry.at}-${index}`}>
                      <span>{ACTIVITY[entry.type] || 'Did something'}</span>
                      <span className={styles.when}>
                        {formatManila(entry.at)}
                        {entry.device ? ` · ${entry.device}${entry.thisDevice ? ' (this browser)' : ''}` : ''}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      </aside>
    </div>,
    document.body
  );
}

export default DetailsPanel;
