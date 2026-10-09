import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ArrowSquareOut, CheckCircle, DownloadSimple, FileText, LinkBreak } from '@phosphor-icons/react';

import wardenLogo from '../assets/warden_logo_badge.svg';
import OtpChallengePanel from '../components/OtpChallengePanel.jsx';
import PasswordInput from './auth/PasswordInput.jsx';
import {
  fetchSharedManifest,
  fetchSharedFile,
  openAccess,
  requestEmailCode,
  unlockShare,
  verifyEmailCode,
} from '../services/sharedService.js';
import {
  decryptBlob,
  decryptManifestInfo,
  importShareKey,
  importShareKeyBytes,
  previewKind,
  readKeyFromHash,
  base64ToBytes,
} from '../utils/shareCrypto.js';
import { downloadName, sanitizeDownloadName } from '../utils/fileNames.js';
import { PDF_DOWNLOAD_NOTE, isStampable, stampImageBlob, watermarkText } from '../utils/watermark.js';
import Watermark from '../components/Watermark.jsx';
import PdfViewer from '../components/preview/PdfViewer.jsx';
import { deriveShareSecrets, unwrapShareKey } from '../utils/sharePassword.js';
import site from '../components/site/site.module.css';
import forms from '../components/site/forms.module.css';
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
  link.download = sanitizeDownloadName(filename);
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
async function openSharedFile({ shareId, key, entry, accessToken }) {
  const encrypted = await fetchSharedFile(shareId, entry.id, accessToken);
  const plain = await decryptBlob(key, shareId, entry.id, encrypted);
  const kind = previewKind(entry.mime, new Uint8Array(plain, 0, Math.min(16, plain.byteLength)));
  const blob = new Blob([plain], { type: kind ? entry.mime : 'application/octet-stream' });
  // Named exactly as the vault names a download: sanitised, extension recovered from the bytes.
  return { blob, kind, mime: entry.mime, bytes: new Uint8Array(plain), url: URL.createObjectURL(blob), fileName: downloadName(entry.name, new Uint8Array(plain)) };
}

/**
 * What a download saves. With a watermark, png/jpeg/webp images are stamped (canvas) with the same text as the
 * preview; PDFs and everything else are the original bytes. Returns { url, revoke }.
 */
async function downloadTarget(opened, watermark) {
  if (watermark && opened.kind === 'image' && isStampable(opened.mime)) {
    const stamped = await stampImageBlob(opened.blob, opened.mime, watermark);
    if (stamped !== opened.blob) {
      const url = URL.createObjectURL(stamped);
      return { url, revoke: () => URL.revokeObjectURL(url) };
    }
  }
  return { url: opened.url, revoke: () => {} };
}

/**
 * One file from a share link. A link with a single entry is `eager`: it
 * decrypts on load and shows an image preview. With several entries each file
 * is fetched and decrypted on demand, so opening a folder link doesn't pull
 * every file at once.
 */
function SharedFile({ shareId, shareKey, accessToken, entry, eager, watermark = null }) {
  // Named sharedFile, not "document" - this component needs the real global
  // `document` (document.createElement) for the click fallbacks above.
  const [sharedFile, setSharedFile] = useState(null); // { url, kind, size, fileName }
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [viewing, setViewing] = useState(false);
  const urlRef = useRef(null);
  const loadedRef = useRef(null);

  const load = useCallback(async () => {
    if (loadedRef.current) return loadedRef.current;
    setBusy(true);
    setFailed(false);
    try {
      const opened = await openSharedFile({ shareId, key: shareKey, entry, accessToken });
      urlRef.current = opened.url;
      const loaded = { url: opened.url, kind: opened.kind, size: opened.blob.size, fileName: opened.fileName, blob: opened.blob, mime: opened.mime, bytes: opened.bytes };
      loadedRef.current = loaded;
      setSharedFile(loaded);
      return loaded;
    } catch {
      setFailed(true);
      return null;
    } finally {
      setBusy(false);
    }
  }, [shareId, shareKey, accessToken, entry]);

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
    // A watermarked share previews inside this page (a blob in a new tab could not carry the overlay).
    if (loaded?.kind && watermark) setViewing(true);
    else if (loaded?.kind) openInNewTab(loaded.url);
    else if (loaded) setFailed(true);
  };

  useEffect(() => {
    if (!viewing) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') setViewing(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewing]);

  const handleDownload = async () => {
    const loaded = await load();
    if (!loaded) return;
    const target = await downloadTarget(loaded, watermark);
    saveBlobAs(target.url, loaded.fileName);
    setTimeout(target.revoke, 60_000);
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
          <div className={styles.watermarked}>
            <img src={sharedFile.url} alt="" className={styles.previewImage} />
            <Watermark text={watermark} />
          </div>
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
        {watermark && entry.mime === 'application/pdf' && !failed && <p className={styles.savedHint}>{PDF_DOWNLOAD_NOTE}</p>}
        {downloaded && <p className={styles.savedHint}>Saved to this device</p>}
        {!maybePreviewable && !failed && !downloaded && (
          <p className={styles.savedHint}>This file type can only be downloaded.</p>
        )}
      </div>

      {viewing && sharedFile?.kind && (
        <div className={styles.lightbox} role="dialog" aria-modal="true" aria-label={`Preview of ${entry.name}`}>
          <div className={styles.lightboxBar}>
            <span className={styles.lightboxName}>{entry.name}</span>
            <button type="button" className={styles.lightboxClose} onClick={() => setViewing(false)}>
              Close
            </button>
          </div>
          <div className={styles.lightboxStage}>
            <div className={styles.watermarked}>
              {sharedFile.kind === 'image' ? (
                <img src={sharedFile.url} alt="" className={styles.lightboxImage} />
              ) : (
                <PdfViewer bytes={sharedFile.bytes} onFail={() => { setViewing(false); setFailed(true); }} />
              )}
              <Watermark text={watermark} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The recipient-facing page for a share link (/shared/:shareId[#k=...]).
 * Deliberately NOT nested under App's authenticated routing in any way - it
 * never reads the session token and never redirects to /login.
 *
 * What the visitor goes through depends on what the owner chose:
 *   1. an emailed 6-digit code, if the link is restricted to an address;
 *   2. the link's password, if it has one (the key is then NOT in the link:
 *      it comes back wrapped, and only the password opens it);
 *   3. otherwise the key is the one after the # in the address.
 * Each step is checked by the server before it releases anything, but none of
 * them is a key: the files are always decrypted here, in the browser.
 *
 * The #k key is read once, from the address the page was opened with, then
 * removed from the address bar and history with replaceState and kept only in
 * memory. It is never sent to any API. (Because it is removed, reloading the
 * page cannot decrypt anything: open the full link again.)
 */
function SharedDocumentPage() {
  const { shareId } = useParams();

  // Read once, during the first render, so a remount (React StrictMode in
  // development) still sees it after the effect below has cleared it.
  const [keyText] = useState(() => readKeyFromHash(window.location.hash));

  // loading | invalid | incomplete | email | password | ready
  const [phase, setPhase] = useState('loading');
  const [access, setAccess] = useState(null);
  const [shareKey, setShareKey] = useState(null);
  const [entries, setEntries] = useState([]);
  const [purposeInfo, setPurposeInfo] = useState({ purpose: null, sharedAt: '' });
  const [downloadingAll, setDownloadingAll] = useState(false);

  // email step
  const [emailStage, setEmailStage] = useState('send'); // send | code
  const [codeChallenge, setCodeChallenge] = useState(null);
  const [emailNote, setEmailNote] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);

  // password step
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);

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

  /** Opens the manifest with a key and shows the files; any failure is the one generic page. */
  const loadFiles = async (key, token) => {
    try {
      const manifest = await fetchSharedManifest(shareId, token);
      const { files, purpose, sharedAt } = await decryptManifestInfo(key, shareId, manifest.manifest);
      // Only files the server actually holds, in manifest order.
      const held = new Set(manifest.files.map((file) => file.id));
      const usable = files.filter((file) => held.has(file.id));
      if (usable.length === 0) throw new Error('empty');
      setShareKey(key);
      setPurposeInfo({ purpose, sharedAt });
      setEntries(usable);
      setPhase('ready');
    } catch {
      setPhase('invalid');
    }
  };

  /** Called when the gates that come before the key are done. */
  const afterGates = async (current, extra = {}) => {
    if (current.needsPassword && !extra.keyFromPassword) {
      setPhase('password');
      return;
    }
    if (extra.keyFromPassword) {
      await loadFiles(extra.keyFromPassword, current.accessToken);
      return;
    }
    if (!keyText) {
      // The share exists and its gates are passed, but the address has no key: the link was cut off.
      setPhase('incomplete');
      return;
    }
    try {
      await loadFiles(await importShareKey(keyText), current.accessToken);
    } catch {
      setPhase('invalid');
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const opened = await openAccess(shareId);
        if (cancelled) return;
        setAccess(opened);
        if (opened.needsEmail) {
          setPhase('email');
          return;
        }
        await afterGates(opened);
      } catch {
        // Missing, expired, revoked, limit reached: one answer for all.
        if (!cancelled) setPhase('invalid');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareId]);

  // ---- email step ----
  const sendCode = async () => {
    setEmailBusy(true);
    setEmailNote('');
    try {
      const sent = await requestEmailCode(shareId, access.accessToken);
      setCodeChallenge({ ...sent, challengeToken: access.accessToken });
      setEmailStage('code');
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429) setEmailNote('Too many codes have been requested for this link. Please try again later.');
      else if (status === 404) setPhase('invalid');
      else setEmailNote('We couldn’t send the code. Please try again in a moment.');
    } finally {
      setEmailBusy(false);
    }
  };

  const emailVerified = async () => {
    if (access.needsPassword) setPhase('password');
    else await afterGates(access);
  };

  // ---- password step ----
  const submitPassword = async (event) => {
    event.preventDefault();
    if (passwordBusy || !password) return;
    setPasswordBusy(true);
    setPasswordError('');
    try {
      // The password never leaves this browser: it is turned into a verifier
      // (for the server to check) and a separate wrap key (to open the key).
      const salt = base64ToBytes(access.password.salt);
      const { wrapKey, verifier } = await deriveShareSecrets(password, salt, access.password.kdf);
      const released = await unlockShare(shareId, access.accessToken, verifier);
      const keyBytes = await unwrapShareKey(released.wrappedKey, wrapKey, shareId);
      setPassword('');
      await afterGates(access, { keyFromPassword: await importShareKeyBytes(keyBytes) });
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429) setPasswordError('Too many wrong passwords for this link. Please try again later.');
      else if (status === 404) setPhase('invalid');
      else setPasswordError('That password is incorrect.');
    } finally {
      setPasswordBusy(false);
    }
  };

  const handleDownloadAll = async () => {
    setDownloadingAll(true);
    try {
      for (const entry of entries) {
        // eslint-disable-next-line no-await-in-loop
        const opened = await openSharedFile({ shareId, key: shareKey, entry, accessToken: access.accessToken });
        const target = await downloadTarget(opened, watermark);
        saveBlobAs(target.url, opened.fileName);
        setTimeout(() => {
          URL.revokeObjectURL(opened.url);
          target.revoke();
        }, 60_000);
      }
    } catch {
      // A failure partway just stops; files already saved stay saved.
    } finally {
      setDownloadingAll(false);
    }
  };

  // A single-file link opens its preview straight away - unless the share has a
  // download limit, where merely opening the page must not use one up.
  const eagerSingle = entries.length === 1 && !access?.limited;
  // No purpose = no watermark and everything exactly as before.
  const watermark = watermarkText(purposeInfo);

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
              It may have expired, been stopped by the person who shared it, used up its downloads, or be missing the
              end of the address. If you reloaded this page, open the full link you were sent again.
            </p>
          </div>
        )}

        {phase === 'incomplete' && (
          <div className={styles.invalidState}>
            <LinkBreak size={40} weight="light" className={styles.invalidIcon} />
            <h1 className={styles.invalidTitle}>This link is incomplete — ask the sender to share it again.</h1>
            <p className={styles.invalidBody}>
              The last part of the address (everything after the #) is missing, so the files cannot be opened. Some apps cut it off. Try
              opening the link in your phone&apos;s browser, or ask the sender to send it again.
            </p>
          </div>
        )}

        {phase === 'email' && access && (
          <div className={styles.documentPanel}>
            <h1 className={styles.gateTitle}>Confirm it&apos;s you</h1>
            {emailStage === 'send' ? (
              <div className={forms.form}>
                <p className={styles.gateText}>
                  The person who shared this chose to share it with one email address. We&apos;ll email a 6-digit code
                  to <strong>{access.maskedEmail}</strong>.
                </p>
                {emailNote && (
                  <div className={forms.alert} role="alert">
                    <p>{emailNote}</p>
                  </div>
                )}
                <button
                  type="button"
                  className={`${site.button} ${site.primary} ${site.block}`}
                  onClick={sendCode}
                  disabled={emailBusy}
                >
                  {emailBusy ? 'Sending…' : 'Email me a code'}
                </button>
              </div>
            ) : (
              <OtpChallengePanel
                challenge={codeChallenge}
                onSubmitCode={(code) => verifyEmailCode(shareId, access.accessToken, code)}
                onResend={async () => ({ ...(await requestEmailCode(shareId, access.accessToken)), challengeToken: access.accessToken })}
                onVerified={emailVerified}
                onBack={() => setEmailStage('send')}
                onDead={(message) => {
                  setEmailNote(message);
                  setEmailStage('send');
                }}
                submitLabel="Continue"
              />
            )}
          </div>
        )}

        {phase === 'password' && access && (
          <div className={styles.documentPanel}>
            <h1 className={styles.gateTitle}>Enter the password</h1>
            <form className={forms.form} onSubmit={submitPassword} noValidate>
              <p className={styles.gateText}>The person who shared this protected it with a password.</p>
              <div role="alert" aria-live="assertive">
                {passwordError && (
                  <div className={forms.alert}>
                    <p>{passwordError}</p>
                  </div>
                )}
              </div>
              <PasswordInput
                id="share-view-password"
                label="Password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="off"
                autoFocus
              />
              <button
                type="submit"
                className={`${site.button} ${site.primary} ${site.block}`}
                disabled={passwordBusy || !password}
              >
                {passwordBusy ? 'Checking…' : 'Open'}
              </button>
            </form>
          </div>
        )}

        {phase === 'ready' && entries.length === 1 && (
          <div className={styles.documentPanel}>
            {purposeInfo.purpose && (
              <p className={styles.purposeLine}>
                <span className={styles.purposeLabel}>Shared for</span> {purposeInfo.purpose}
              </p>
            )}
            <SharedFile
              shareId={shareId}
              shareKey={shareKey}
              accessToken={access.accessToken}
              entry={entries[0]}
              eager={eagerSingle}
              watermark={watermark}
            />
          </div>
        )}

        {phase === 'ready' && entries.length > 1 && (
          <div className={styles.documentPanel}>
            {purposeInfo.purpose && (
              <p className={styles.purposeLine}>
                <span className={styles.purposeLabel}>Shared for</span> {purposeInfo.purpose}
              </p>
            )}
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
                  <SharedFile
                    shareId={shareId}
                    shareKey={shareKey}
                    accessToken={access.accessToken}
                    entry={entry}
                    eager={false}
                    watermark={watermark}
                  />
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
