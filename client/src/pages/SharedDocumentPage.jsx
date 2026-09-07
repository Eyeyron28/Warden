import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ArrowSquareOut, CheckCircle, DownloadSimple, FileText, LinkBreak } from '@phosphor-icons/react';

import wardenLogo from '../assets/warden_logo_badge.svg';
import { fetchSharedDocument } from '../services/sharedService.js';
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

/**
 * The recipient-facing page for a share link (/shared/:token). Deliberately
 * NOT nested under App's authenticated routing in any way - it never reads
 * the session token, never redirects to LockScreen, and renders its own
 * minimal shell rather than VaultShell's. Anyone with the link opens this
 * directly, with no prior context and no account.
 */
function SharedDocumentPage() {
  const { token } = useParams();

  const [loading, setLoading] = useState(true);
  const [invalid, setInvalid] = useState(false);
  // Named sharedFile, not "document" - this component needs the real
  // global `document` (document.createElement) for the View/Download
  // click fallbacks below, and a state variable named `document` would
  // shadow it everywhere in this scope.
  const [sharedFile, setSharedFile] = useState(null); // { blobUrl, filename, contentType, size }
  const [downloaded, setDownloaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl = null;

    fetchSharedDocument(token)
      .then(({ blob, filename, contentType }) => {
        if (cancelled) return;
        // Reconstructed with an explicit type rather than trusting
        // blob.type as-is, so the Blob driving both View and Download
        // definitely carries the real MIME type from the response header,
        // not whatever the browser guessed - one decrypted Blob, reused
        // for both buttons instead of fetching/decrypting twice.
        const typedBlob = new Blob([blob], { type: contentType || blob.type });
        objectUrl = URL.createObjectURL(typedBlob);
        setSharedFile({ blobUrl: objectUrl, filename, contentType, size: typedBlob.size });
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
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [token]);

  const isImage = sharedFile?.contentType?.startsWith('image/');

  // Deliberately no inline iframe/object/embed for PDFs any more - on
  // Android Chrome that renders a broken placeholder with a dead "Open"
  // button. Handing the blob URL to window.open lets the phone's own
  // PDF viewer (or whatever app handles the file type) open it instead.
  const handleView = () => {
    if (!sharedFile) return;
    const opened = window.open(sharedFile.blobUrl, '_blank');
    if (!opened) {
      // Popup blocked - fall back to a real (user-gesture-driven) anchor
      // click, which browsers don't block the way they block window.open.
      const link = document.createElement('a');
      link.href = sharedFile.blobUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
    }
  };

  const handleDownload = () => {
    if (!sharedFile) return;
    const link = document.createElement('a');
    link.href = sharedFile.blobUrl;
    link.download = sharedFile.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // In-memory only, on purpose: a share page is a one-time public view
    // with no account behind it, so there's nothing to persist to
    // IndexedDB/localStorage for - this just reflects "already saved
    // this visit" back to whoever's looking at the screen right now.
    setDownloaded(true);
  };

  return (
    <div className={styles.page}>
      <header className={styles.brand}>
        <img src={wardenLogo} alt="" className={styles.brandMark} />
        <span className={styles.brandText}>Shared via Warden</span>
      </header>

      <main className={styles.content}>
        {loading && <p className={styles.hint}>Loading document...</p>}

        {!loading && invalid && (
          <div className={styles.invalidState}>
            <LinkBreak size={40} weight="light" className={styles.invalidIcon} />
            <h1 className={styles.invalidTitle}>This link is no longer valid.</h1>
            <p className={styles.invalidBody}>
              It may have expired or been revoked by the person who shared it.
            </p>
          </div>
        )}

        {!loading && !invalid && sharedFile && (
          <div className={styles.documentPanel}>
            <div className={styles.panelBody}>
              <div className={styles.previewColumn}>
                <div className={styles.fileCard}>
                  <FileText size={28} weight="light" className={styles.fileIcon} />
                  <div className={styles.fileInfo}>
                    <span className={styles.filename}>{sharedFile.filename}</span>
                    <span className={styles.fileMeta}>
                      {getFileTypeLabel(sharedFile.filename, sharedFile.contentType)}
                      {' · '}
                      {formatFileSize(sharedFile.size)}
                    </span>
                  </div>
                </div>

                {isImage && (
                  <img
                    src={sharedFile.blobUrl}
                    alt={sharedFile.filename}
                    className={styles.previewImage}
                  />
                )}
              </div>

              <div className={styles.actionsColumn}>
                <div className={styles.actionRow}>
                  <button type="button" className={styles.viewButton} onClick={handleView}>
                    <ArrowSquareOut size={16} weight="bold" />
                    <span>View</span>
                  </button>
                  <button type="button" className={styles.downloadButton} onClick={handleDownload}>
                    {downloaded ? (
                      <CheckCircle size={16} weight="bold" />
                    ) : (
                      <DownloadSimple size={16} weight="bold" />
                    )}
                    <span>{downloaded ? 'Downloaded' : 'Download'}</span>
                  </button>
                </div>

                {downloaded && <p className={styles.savedHint}>Saved to this device</p>}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default SharedDocumentPage;
