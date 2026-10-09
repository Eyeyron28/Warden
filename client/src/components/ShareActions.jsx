import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, DownloadSimple, QrCode, ShareNetwork } from '@phosphor-icons/react';

import {
  QR_OPTIONS,
  buildShareTargets,
  copyText,
  isAllowedShareHref,
  isMobileDevice,
  nativeSharePayload,
  qrPayload,
} from '../utils/shareLinks.js';
import styles from './ShareActions.module.css';

// A coloured letter badge per app: no third-party icon files, nothing loaded from another site.
const BADGES = {
  whatsapp: { letter: 'W', color: '#1fa855' },
  telegram: { letter: 'T', color: '#1d8fd1' },
  viber: { letter: 'V', color: '#6f5bd6' },
  gmail: { letter: 'G', color: '#d93025' },
  messenger: { letter: 'M', color: '#0a7cff' },
};

const COPIED_MS = 2000;
const APP_WAIT_MS = 1600;

/**
 * Everything you can do with a finished share link: copy it, show it as a QR,
 * or send it through an app. The link (with its #k= key) goes only where the
 * person points it - their clipboard, the QR drawn right here, or the app they
 * choose - never to Warden's server. Targets come from utils/shareLinks.js,
 * which encodes every value and allows only https, viber and fb-messenger.
 */
function ShareActions({ link, passwordProtected = false, recipientEmail = '' }) {
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState('');
  const [qrOpen, setQrOpen] = useState(false);
  const [qrUrl, setQrUrl] = useState(null);
  const timers = useRef([]);

  const env = typeof navigator === 'undefined' ? {} : navigator;
  const mobile = isMobileDevice(env.userAgent || '', env.maxTouchPoints || 0);
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const targets = buildShareTargets({ link, recipientEmail, mobile });

  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (fn, ms) => timers.current.push(setTimeout(fn, ms));

  // The QR is drawn in the browser from the same string Copy copies.
  useEffect(() => {
    if (!qrOpen) return undefined;
    let cancelled = false;
    QRCode.toDataURL(qrPayload(link), { ...QR_OPTIONS })
      .then((url) => !cancelled && setQrUrl(url))
      .catch(() => !cancelled && setQrUrl(null));
    return () => {
      cancelled = true;
    };
  }, [qrOpen, link]);

  const handleCopy = async () => {
    const ok = await copyText(link);
    setNotice(ok ? '' : 'Could not copy automatically. Press and hold the link above to select it.');
    if (ok) {
      setCopied(true);
      later(() => setCopied(false), COPIED_MS);
    }
  };

  const handleNativeShare = async () => {
    try {
      await navigator.share(nativeSharePayload(link));
    } catch (err) {
      // Closing the share sheet is not an error.
      if (err?.name !== 'AbortError') setNotice('Sharing did not work. Copy the link instead.');
    }
  };

  /** A custom-scheme link: if nothing takes the page away from us, no app handled it. */
  const openApp = (target) => {
    if (!isAllowedShareHref(target.href)) return;
    let handled = false;
    const mark = () => {
      handled = true;
    };
    document.addEventListener('visibilitychange', mark);
    window.addEventListener('blur', mark);
    window.addEventListener('pagehide', mark);
    const anchor = document.createElement('a');
    anchor.href = target.href;
    anchor.rel = 'noopener noreferrer';
    anchor.click();
    later(async () => {
      document.removeEventListener('visibilitychange', mark);
      window.removeEventListener('blur', mark);
      window.removeEventListener('pagehide', mark);
      if (!handled) {
        await copyText(link);
        setNotice(target.note);
      }
    }, APP_WAIT_MS);
  };

  const copyThenOpen = async (target) => {
    if (!isAllowedShareHref(target.href)) return;
    await copyText(link);
    setNotice(target.note);
    window.open(target.href, '_blank', 'noopener,noreferrer');
  };

  const downloadQr = () => {
    if (!qrUrl) return;
    const anchor = document.createElement('a');
    anchor.href = qrUrl;
    anchor.download = 'warden-share-qr.png';
    anchor.click();
  };

  return (
    <div className={qrOpen ? `${styles.actions} ${styles.withQr}` : styles.actions}>
      <div className={styles.linkRow}>
        <input
          type="text"
          className={styles.linkInput}
          value={link}
          readOnly
          aria-label="Share link"
          onFocus={(event) => event.target.select()}
        />
        <button type="button" className={styles.copyButton} onClick={handleCopy}>
          {copied ? <Check size={16} weight="bold" /> : <Copy size={16} weight="bold" />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>

      {canNativeShare && (
        <button type="button" className={styles.nativeShare} onClick={handleNativeShare}>
          <ShareNetwork size={18} weight="bold" aria-hidden="true" />
          <span>Share…</span>
        </button>
      )}

      <div className={styles.appGrid} role="group" aria-label="Send the link with an app">
        {targets.map((target) => {
          const badge = BADGES[target.id];
          const content = (
            <>
              <span className={styles.badge} style={{ background: badge.color }} aria-hidden="true">
                {badge.letter}
              </span>
              <span>{target.label}</span>
            </>
          );
          if (target.mode === 'link') {
            return (
              <a key={target.id} className={styles.appButton} href={target.href} target="_blank" rel="noopener noreferrer">
                {content}
              </a>
            );
          }
          return (
            <button
              key={target.id}
              type="button"
              className={styles.appButton}
              onClick={() => (target.mode === 'app' ? openApp(target) : copyThenOpen(target))}
            >
              {content}
            </button>
          );
        })}
        <button type="button" className={styles.appButton} onClick={() => setQrOpen((open) => !open)} aria-expanded={qrOpen}>
          <span className={styles.badge} style={{ background: '#5e5160' }} aria-hidden="true">
            <QrCode size={14} weight="bold" />
          </span>
          <span>{qrOpen ? 'Hide QR' : 'QR code'}</span>
        </button>
      </div>

      <p className={styles.notice} role="status" aria-live="polite">
        {notice}
      </p>

      {qrOpen && (
        <div className={styles.qrPanel}>
          <div className={styles.qrFrame}>
            {qrUrl ? <img src={qrUrl} alt="QR code for the share link" className={styles.qrImage} /> : <span className={styles.qrWait}>Drawing…</span>}
          </div>
          <div className={styles.qrSide}>
            <p className={styles.small}>Point a phone camera at it to open the link.</p>
            {passwordProtected && <p className={styles.small}><strong>Send the password separately.</strong></p>}
            <button type="button" className={styles.downloadButton} onClick={downloadQr} disabled={!qrUrl}>
              <DownloadSimple size={16} weight="bold" aria-hidden="true" />
              <span>Download PNG</span>
            </button>
          </div>
        </div>
      )}

      <p className={styles.warning}>
        Anyone you send this link to — and the app you send it through — can open it. Add a link password for sensitive files and send
        the password separately.
      </p>
    </div>
  );
}

export default ShareActions;
