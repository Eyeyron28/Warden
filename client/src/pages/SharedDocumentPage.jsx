import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { DownloadSimple, FileText, LinkBreak } from '@phosphor-icons/react';

import wardenLogo from '../assets/warden_logo_badge.svg';
import { fetchSharedDocument } from '../services/sharedService.js';
import styles from './SharedDocumentPage.module.css';

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
  const [document, setDocument] = useState(null); // { blobUrl, filename, contentType }

  useEffect(() => {
    let cancelled = false;
    let objectUrl = null;

    fetchSharedDocument(token)
      .then(({ blob, filename, contentType }) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setDocument({ blobUrl: objectUrl, filename, contentType });
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

  const isImage = document?.contentType?.startsWith('image/');
  const isPdf = document?.contentType === 'application/pdf';

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

        {!loading && !invalid && document && (
          <div className={styles.documentPanel}>
            <div className={styles.documentHeader}>
              <FileText size={20} weight="light" className={styles.fileIcon} />
              <span className={styles.filename}>{document.filename}</span>
            </div>

            {isImage && (
              <img src={document.blobUrl} alt={document.filename} className={styles.previewImage} />
            )}

            {isPdf && (
              <iframe src={document.blobUrl} title={document.filename} className={styles.previewFrame} />
            )}

            {!isImage && !isPdf && (
              <p className={styles.noPreview}>No preview available for this file type.</p>
            )}

            <a href={document.blobUrl} download={document.filename} className={styles.downloadButton}>
              <DownloadSimple size={16} weight="bold" />
              <span>Download</span>
            </a>
          </div>
        )}
      </main>
    </div>
  );
}

export default SharedDocumentPage;
