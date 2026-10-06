import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ArrowSquareOut, CheckCircle, DownloadSimple, FileText, LinkBreak } from '@phosphor-icons/react';

import wardenLogo from '../assets/warden_logo_badge.svg';
import { fetchSharedManifest, fetchSharedFile } from '../services/sharedService.js';
import {
  decryptBlob,
  decryptManifest,
  importShareKey,
  previewKind,
  readKeyFromHash,
  safeDownloadName,
} from '../utils/shareCrypto.js';
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

function getFileTypeLabel(filename) {
  const match = /\.([a-z0-9]{1,8})$/i.exec(filename || '');
  return match ? match[1].toUpperCase() : 'FILE';
}

function saveBlobAs(url, filename) {
  const link = document.createElement('a');
  link.href = url;
  link.download = safeDownloadName(filename);
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function openInNewTab(url) {
  const opened = window.open(url, '_blank', 'noopener');
  if (!opened) {
    // Popup blocked - fall back to a real (user-gesture-driven) anchor
    // click, which browsers don't block the way they block window.open.
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
}

/**
 * Fetches one encrypted file and decrypts it HERE, in the browser. Everything
 * about the result is treated as untrusted (the owner chose the name and the
 * declared type, and the bytes are whatever they uploaded):
 *   - only png/jpeg/gif/webp/pdf whose own first bytes match their label may
 *     be previewed inline, from a blob URL typed as that exact type;
 *   - everything else - html, svg, scripts, unknown - is typed as opaque
 *     bytes and can only be downloaded, never rendered by this page.
 */
async function openSharedFile({ shareId, key, entry }) {
  const encrypted = await fetchSharedFile(shareId, entry.id);
  const plain = await decryptBlob(key, shareId, entry.id, encrypted);
  const kind = previewKind(entry.mime, new Uint8Array(plain, 0, Math.min(16, plain.byteLength)));
  const blob = new Blob([plain], { type: kind ? entry.mime : 'application/octet-stream' });
  return { blob, kind, url: URL.createObjectURL(blob) };
}

/**
 * One file from a share link. A link with a single entry is `eager`: it
 * decrypts on load and shows an image preview. With several entries each file
 * is fetched and decrypted on demand, so opening a folder link doesn't pull
 * every file at once.
 */
function SharedFile({ shareId, shareKey, entry, eager }) {
  // Named sharedFile, not "document" - this component needs the real global
  // `document` (document.createElement) for the click fallbacks above.
  const [sharedFile, setSharedFile] = useState(null); // { url, kind, size }
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const urlRef = useRef(null);
  const loadedRef = useRef(null);

  const load = useCallback(async () => {
    if (loadedRef.current) return loadedRef.current;
    setBusy(true);
    setFailed(false);
    try {
      const opened = await openSharedFile({ shareId, key: shareKey, entry });
      urlRef.current = opened.url;
      const loaded = { url: opened.url, kind: opened.kind, size: opened.blob.size };
      loadedRef.current = loaded;
      setSharedFile(loaded);
      return loaded;
    } catch {
      setFailed(true);
      return null;
    } finally {
      setBusy(false);
    }
  }, [shareId, shareKey, entry]);

  useEffect(() => {
    if (eager) load();
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
      loadedRef.current = null;
    };
  }, [eager, load]);

  // Whether a View button is offered depends on the declared type being one
  // we may preview; whether the bytes really match is confirmed on load.
  const maybePreviewable = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'].includes(
    entry.mime
  );

  const handleView = async () => {
    const loaded = await load();
    if (loaded?.kind) openInNewTab(loaded.url);
    else if (loaded) setFailed(true);
  };

  const handleDownload = async () => {
    const loaded = await load();
    if (!loaded) return;
    saveBlobAs(loaded.url, entry.name);
    // In-memory only, on purpose: a share page is a public view with no
    // account behind it.
    setDownloaded(true);
  };

  const size = sharedFile?.size ?? entry.size;
  const folderLabel = entry.folder && entry.folder !== 'root' ? entry.folder : '';

  return (
    <div className={eager ? styles.panelBody : styles.fileRow}>
      <div className={styles.previewColumn}>
        <div className={styles.fileCard}>
          <FileText size={28} weight="light" className={styles.fileIcon} />
          <div className={styles.fileInfo}>
            {/* Plain text children only: React escapes the name. */}
            <span className={styles.filename} title={entry.name}>
              {entry.name}
            </span>
            <span className={styles.fileMeta}>
              {getFileTypeLabel(entry.name)}
              {' · '}
              {formatFileSize(size)}
              {folderLabel ? ` · ${folderLabel}` : ''}
            </span>
          </div>
        </div>

        {eager && sharedFile?.kind === 'image' && (
          <img src={sharedFile.url} alt="" className={styles.previewImage} />
        )}
      </div>

      <div className={styles.actionsColumn}>
        <div className={styles.actionRow}>
          {maybePreviewable && (
            <button type="button" className={styles.viewButton} onClick={handleView} disabled={busy}>
              <ArrowSquareOut size={16} weight="bold" />
              <span>View</span>
            </button>
          )}
          <button type="button" className={styles.downloadButton} onClick={handleDownload} disabled={busy}>
            {downloaded ? <CheckCircle size={16} weight="bold" /> : <DownloadSimple size={16} weight="bold" />}
            <span>{downloaded ? 'Downloaded' : 'Download'}</span>
          </button>
        </div>

        {failed && <p className={styles.savedHint}>Could not open this file.</p>}
        {downloaded && <p className={styles.savedHint}>Saved to this device</p>}
        {!maybePreviewable && !failed && !downloaded && (
          <p className={styles.savedHint}>This file type can only be downloaded.</p>
        )}
      </div>
    </div>
  );
}

/**
 * The recipient-facing page for a share link (/shared/:shareId#k=...).
 * Deliberately NOT nested under App's authenticated routing in any way - it
 * never reads the session token and never redirects to /login.
 *
 * The key after the # is read once, from the address the page was opened
 * with, then removed from the address bar and history with replaceState and
 * kept only in memory. It is never sent to any API. (Because it is removed,
 * reloading the page cannot decrypt anything: open the full link again.)
 */
function SharedDocumentPage() {
  const { shareId } = useParams();

  // Read once, during the first render, so a remount (React StrictMode in
  // development) still sees it after the effect below has cleared it.
  const [keyText] = useState(() => readKeyFromHash(window.location.hash));

  const [phase, setPhase] = useState('loading'); // loading | invalid | ready
  const [shareKey, setShareKey] = useState(null);
  const [entries, setEntries] = useState([]);
  const [downloadingAll, setDownloadingAll] = useState(false);

  useEffect(() => {
    // Take the key out of the address bar and the history entry.
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    // Belt and braces alongside the Referrer-Policy response header
    // (vercel.json): this page never leaks its address to anything it opens.
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fail = () => {
      if (!cancelled) setPhase('invalid');
    };

    if (!keyText) {
      fail();
      return undefined;
    }

    (async () => {
      try {
        const manifest = await fetchSharedManifest(shareId);
        const key = await importShareKey(keyText);
        const files = await decryptManifest(key, shareId, manifest.manifest);
        // Only files the server actually holds, in manifest order.
        const held = new Set(manifest.files.map((file) => file.id));
        const usable = files.filter((file) => held.has(file.id));
        if (usable.length === 0) throw new Error('empty');
        if (cancelled) return;
        setShareKey(key);
        setEntries(usable);
        setPhase('ready');
      } catch {
        // Missing, expired, revoked, or the wrong key: one answer for all.
        fail();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [shareId, keyText]);

  const handleDownloadAll = async () => {
    setDownloadingAll(true);
    try {
      for (const entry of entries) {
        // eslint-disable-next-line no-await-in-loop
        const opened = await openSharedFile({ shareId, key: shareKey, entry });
        saveBlobAs(opened.url, entry.name);
        setTimeout(() => URL.revokeObjectURL(opened.url), 60_000);
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
        {phase === 'loading' && <p className={styles.hint}>Loading...</p>}

        {phase === 'invalid' && (
          <div className={styles.invalidState}>
            <LinkBreak size={40} weight="light" className={styles.invalidIcon} />
            <h1 className={styles.invalidTitle}>This link is no longer valid.</h1>
            <p className={styles.invalidBody}>
              It may have expired, been revoked by the person who shared it, or be missing the end of the
              address. If you reloaded this page, open the full link you were sent again.
            </p>
          </div>
        )}

        {phase === 'ready' && entries.length === 1 && (
          <div className={styles.documentPanel}>
            <SharedFile shareId={shareId} shareKey={shareKey} entry={entries[0]} eager />
          </div>
        )}

        {phase === 'ready' && entries.length > 1 && (
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
                  <SharedFile shareId={shareId} shareKey={shareKey} entry={entry} eager={false} />
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
