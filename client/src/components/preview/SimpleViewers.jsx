import { useEffect, useMemo, useRef, useState } from 'react';
import { DownloadSimple, FileX } from '@phosphor-icons/react';

import FileTypeIcon from '../FileTypeIcon.jsx';
import { renderDocxToSrcdoc } from '../../utils/docxRender.js';
import styles from './Preview.module.css';

const MAX_TEXT_CHARS = 512 * 1024;

/**
 * Plain text and markdown, shown as TEXT: the decoded string goes in as a
 * React text node (never as HTML), so markup in the file is just characters.
 */
export function TextViewer({ bytes }) {
  const { text, truncated } = useMemo(() => {
    const decoded = new TextDecoder('utf-8').decode(bytes.subarray(0, MAX_TEXT_CHARS * 2));
    return decoded.length > MAX_TEXT_CHARS
      ? { text: decoded.slice(0, MAX_TEXT_CHARS), truncated: true }
      : { text: decoded, truncated: false };
  }, [bytes]);

  return (
    <div className={styles.textWrap}>
      {text.length === 0 ? (
        <p className={styles.stageNote}>This file is empty.</p>
      ) : (
        <pre className={styles.text} tabIndex={0}>
          {text}
        </pre>
      )}
      {truncated && <p className={styles.truncated}>Showing the first part of this file. Download it to read the rest.</p>}
    </div>
  );
}

/** Audio and video through the browser's own player, from an allowlisted-type Blob URL. */
export function MediaViewer({ bytes, mime, kind, name, onFail }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [bytes, mime]);
  if (!url) return null;
  return kind === 'video' ? (
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <video className={styles.video} src={url} controls playsInline preload="metadata" onError={onFail} aria-label={name} />
  ) : (
    <div className={styles.audioWrap}>
      <FileTypeIcon filename={name} size={64} />
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio className={styles.audio} src={url} controls preload="metadata" onError={onFail} aria-label={name} />
    </div>
  );
}

/**
 * A .docx rendered by docx-preview inside a sandboxed iframe (see
 * utils/docxRender.js). The iframe has an empty sandbox attribute - no
 * scripts, no same-origin - and a CSP that blocks every network load; if
 * anything goes wrong the viewer asks for the "No preview" card instead.
 */
export function DocxViewer({ bytes, name, onFail }) {
  const [html, setHtml] = useState(null);
  const failed = useRef(onFail);
  failed.current = onFail;

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    renderDocxToSrcdoc(bytes)
      .then((result) => !cancelled && setHtml(result))
      .catch(() => !cancelled && failed.current());
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  if (html === null) return <p className={styles.stageNote}>Preparing preview…</p>;
  return (
    <iframe
      className={styles.docx}
      title={`Preview of ${name}`}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={html}
    />
  );
}

/** The card shown when a file can't (or shouldn't) be previewed. */
export function NoPreview({ name, reason, onDownload, busy }) {
  return (
    <div className={styles.noPreview}>
      <div className={styles.noPreviewIcon}>
        <FileTypeIcon filename={name} size={56} />
        <FileX size={22} weight="bold" className={styles.noPreviewBadge} aria-hidden="true" />
      </div>
      <h2 className={styles.noPreviewTitle}>No preview available</h2>
      <p className={styles.noPreviewText}>{reason}</p>
      <button type="button" className={styles.primary} onClick={onDownload} disabled={busy}>
        <DownloadSimple size={18} weight="bold" />
        <span>{busy ? 'Preparing…' : 'Download'}</span>
      </button>
    </div>
  );
}
