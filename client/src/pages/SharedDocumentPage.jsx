import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ArrowSquareOut, CheckCircle, DownloadSimple, FileText, LinkBreak } from '@phosphor-icons/react';

import wardenLogo from '../assets/warden_logo_badge.svg';
import { fetchSharedManifest, fetchSharedFile } from '../services/sharedService.js';
import styles from './SharedDocumentPage.module.css';

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

function getFileTypeLabel(filename, contentType) {
  const match = /\.([a-z0-9]+)$/i.exec(filename || '');
  if (match) return match[1].toUpperCase();
  const subtype = contentType?.split('/')[1];
  return subtype ? subtype.toUpperCase() : 'FILE';
}

function saveBlobAs(url, filename) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function openInNewTab(url) {
  const opened = window.open(url, '_blank');
  if (!opened) {
    // Popup blocked - fall back to a real (user-gesture-driven) anchor
    // click, which browsers don't block the way they block window.open.
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
}

/**
 * One file from a share link. A link with a single entry (the original,
 * only case before folder sharing) is `eager`: it decrypts on load and shows
 * the image preview, exactly as before. With several entries, each file is
 * fetched/decrypted on demand when View or Download is pressed, so opening
 * a folder link doesn't pull every file at once.
 */
function SharedFile({ token, entry, eager }) {
  // Named sharedFile, not "document" - this component needs the real
  // global `document` (document.createElement) for the click fallbacks
  // above, and a variable named `document` would shadow it.
  const [sharedFile, setSharedFile] = useState(null); // { blobUrl, contentType, size }
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const objectUrlRef = useRef(null);
  const loadedRef = useRef(null);

  const load = useCallback(async () => {
    if (loadedRef.current) return loadedRef.current;
    setBusy(true);
    setFailed(false);
    try {
      const { blob, contentType } = await fetchSharedFile(token, entry.id);
      // Reconstructed with an explicit type rather than trusting blob.type
      // as-is, so the Blob driving both View and Download definitely
      // carries the real MIME type from the response header - one
      // decrypted Blob, reused for both buttons instead of fetching twice.
      const typedBlob = new Blob([blob], { type: contentType || blob.type });
      objectUrlRef.current = URL.createObjectURL(typedBlob);
      const loaded = { blobUrl: objectUrlRef.current, contentType, size: typedBlob.size };
      loadedRef.current = loaded;
      setSharedFile(loaded);
      return loaded;
    } catch {
      setFailed(true);
      return null;
    } finally {
      setBusy(false);
    }
  }, [token, entry.id]);

  useEffect(() => {
    if (eager) load();
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
      loadedRef.current = null;
    };
  }, [eager, load]);

  // Deliberately no inline iframe/object/embed for PDFs - on Android
  // Chrome that renders a broken placeholder with a dead "Open" button.
  // Handing the blob URL to window.open lets the phone's own PDF viewer
  // (or whatever app handles the file type) open it instead.
  const handleView = async () => {
    const loaded = await load();
    if (loaded) openInNewTab(loaded.blobUrl);
  };

  const handleDownload = async () => {
    const loaded = await load();
    if (!loaded) return;
    saveBlobAs(loaded.blobUrl, entry.filename);
    // In-memory only, on purpose: a share page is a one-time public view
    // with no account behind it, so this just reflects "already saved this
    // visit" back to whoever's looking at the screen right now.
    setDownloaded(true);
  };

  const contentType = sharedFile?.contentType || entry.mimeType;
  const isImage = eager && sharedFile?.contentType?.startsWith('image/');
  const size = sharedFile?.size ?? entry.size;

  return (
    <div className={eager ? styles.panelBody : styles.fileRow}>
      <div className={styles.previewColumn}>
        <div className={styles.fileCard}>
          <FileText size={28} weight="light" className={styles.fileIcon} />
          <div className={styles.fileInfo}>
            <span className={styles.filename} title={entry.filename}>
              {entry.filename}
            </span>
            <span className={styles.fileMeta}>
              {getFileTypeLabel(entry.filename, contentType)}
              {' · '}
              {formatFileSize(size)}
            </span>
          </div>
        </div>

        {isImage && (
          <img src={sharedFile.blobUrl} alt={entry.filename} className={styles.previewImage} />
        )}
      </div>

      <div className={styles.actionsColumn}>
        <div className={styles.actionRow}>
          <button type="button" className={styles.viewButton} onClick={handleView} disabled={busy}>
            <ArrowSquareOut size={16} weight="bold" />
            <span>View</span>
          </button>
          <button
            type="button"
            className={styles.downloadButton}
            onClick={handleDownload}
            disabled={busy}
          >
            {downloaded ? (
              <CheckCircle size={16} weight="bold" />
            ) : (
              <DownloadSimple size={16} weight="bold" />
            )}
            <span>{downloaded ? 'Downloaded' : 'Download'}</span>
          </button>
        </div>

        {failed && <p className={styles.savedHint}>Could not open this file.</p>}
        {downloaded && <p className={styles.savedHint}>Saved to this device</p>}
      </div>
    </div>
  );
}

/**
 * The recipient-facing page for a share link (/shared/:token). Deliberately
 * NOT nested under App's authenticated routing in any way - it never reads
 * the session token, never redirects to LockScreen, and renders its own
 * minimal shell rather than VaultShell's. Anyone with the link opens this
 * directly, with no prior context and no account. A link covers one or
 * more files (a shared folder is many); a single-file link looks exactly as
 * it always did.
 */
function SharedDocumentPage() {
  const { token } = useParams();

  const [loading, setLoading] = useState(true);
  const [invalid, setInvalid] = useState(false);
  const [entries, setEntries] = useState([]);
  const [downloadingAll, setDownloadingAll] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetchSharedManifest(token)
      .then((manifest) => {
        if (!cancelled) setEntries(manifest.entries);
      })
      .catch(() => {
        // The backend intentionally returns the same generic response for
        // "never existed", "expired", and "revoked" - there is nothing
        // more specific to show here even if we wanted to.
        if (!cancelled) setInvalid(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleDownloadAll = async () => {
    setDownloadingAll(true);
    try {
      for (const entry of entries) {
        // eslint-disable-next-line no-await-in-loop
        const { blob, filename, contentType } = await fetchSharedFile(token, entry.id);
        const url = URL.createObjectURL(new Blob([blob], { type: contentType || blob.type }));
        saveBlobAs(url, filename);
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch {
      // A failure partway just stops; files already saved stay saved.
    } finally {
      setDownloadingAll(false);
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.brand}>
        <img src={wardenLogo} alt="" className={styles.brandMark} />
        <span className={styles.brandText}>Shared via Warden</span>
      </header>

      <main className={styles.content}>
        {loading && <p className={styles.hint}>Loading...</p>}

        {!loading && invalid && (
          <div className={styles.invalidState}>
            <LinkBreak size={40} weight="light" className={styles.invalidIcon} />
            <h1 className={styles.invalidTitle}>This link is no longer valid.</h1>
            <p className={styles.invalidBody}>
              It may have expired or been revoked by the person who shared it.
            </p>
          </div>
        )}

        {!loading && !invalid && entries.length === 1 && (
          <div className={styles.documentPanel}>
            <SharedFile token={token} entry={entries[0]} eager />
          </div>
        )}

        {!loading && !invalid && entries.length > 1 && (
          <div className={styles.documentPanel}>
            <div className={styles.multiHeader}>
              <span className={styles.multiTitle}>{entries.length} files shared with you</span>
              <button
                type="button"
                className={styles.downloadButton}
                onClick={handleDownloadAll}
                disabled={downloadingAll}
              >
                <DownloadSimple size={16} weight="bold" />
                <span>{downloadingAll ? 'Downloading...' : 'Download all'}</span>
              </button>
            </div>
            <ul className={styles.fileList}>
              {entries.map((entry) => (
                <li key={entry.id}>
                  <SharedFile token={token} entry={entry} eager={false} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>
    </div>
  );
}

export default SharedDocumentPage;
