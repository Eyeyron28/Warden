import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CaretLeft,
  CaretRight,
  DownloadSimple,
  Info,
  PencilSimple,
  ShareNetwork,
  Trash,
  X,
} from '@phosphor-icons/react';
import axios from 'axios';

import ImageViewer from './preview/ImageViewer.jsx';
import PdfViewer from './preview/PdfViewer.jsx';
import { DocxViewer, MediaViewer, NoPreview, TextViewer } from './preview/SimpleViewers.jsx';
import { downloadBytes, fetchDocumentBytes, recordDownload } from '../services/documentsService.js';
import { subscribeToken } from '../services/session.js';
import { MAX_PREVIEW_BYTES, sniffPreviewType } from '../utils/previewType.js';
import { formatDateTime } from '../utils/formatDate.js';
import { formatBytes } from '../utils/listing.js';
import { isTopDialog, useFocusTrap } from '../utils/useFocusTrap.js';
import styles from './preview/Preview.module.css';

const TYPE_LABELS = {
  'image/png': 'PNG image',
  'image/jpeg': 'JPEG image',
  'image/gif': 'GIF image',
  'image/webp': 'WebP image',
  'application/pdf': 'PDF document',
  'audio/mpeg': 'MP3 audio',
  'audio/wav': 'WAV audio',
  'audio/ogg': 'Ogg audio',
  'audio/flac': 'FLAC audio',
  'audio/mp4': 'M4A audio',
  'video/mp4': 'MP4 video',
  'video/webm': 'WebM video',
};

/** A reader-friendly type, from what the BYTES are - not from the file name. */
function describeType(sniff) {
  if (!sniff) return '…';
  if (sniff.mime && TYPE_LABELS[sniff.mime]) return TYPE_LABELS[sniff.mime];
  switch (sniff.kind) {
    case 'docx':
      return 'Word document (.docx)';
    case 'text':
      return 'Plain text';
    case 'markup':
      return 'HTML, SVG or XML (not previewed)';
    default:
      return 'Unknown type';
  }
}

const REASONS = {
  toolarge: 'This file is too large to preview. Download it to open it.',
  markup:
    'HTML, SVG and XML files are never shown here, because they can contain code. Download it to open it in another app.',
  none: 'We can’t preview this type of file here. Download it to open it in another app.',
  failed: 'This file couldn’t be previewed. You can still download it.',
  error: 'We couldn’t open this file just now. Try again, or download it.',
};

const isEditable = (target) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/**
 * Full-screen file viewer. The file is fetched through the authenticated API
 * as raw bytes and its type is decided by sniffing them (utils/previewType.js)
 * against an allowlist - never from the stored name or a declared type. Images,
 * audio and video are shown from object URLs over Blobs typed from that
 * allowlist; PDFs go through pdf.js onto a canvas; text is shown as text;
 * .docx runs in a sandboxed iframe. HTML and SVG are never rendered.
 *
 * Left/Right arrows (and the side buttons) move through `files`, Esc closes,
 * focus stays inside while it is open and returns afterwards (the parent
 * focuses the item it came from). Everything held in memory belongs to this
 * component: bytes go when the file changes or the viewer closes, object URLs
 * are revoked by the viewers, and locking the vault closes it.
 */
function FilePreview({ files, index, onIndexChange, onClose, onShare, onRename, onTrash, onLoaded }) {
  const doc = files[index];
  const overlayRef = useRef(null);
  const bytesRef = useRef(null);
  const nameRef = useRef(null);
  const [state, setState] = useState({ status: 'loading' });
  const [viewerFailed, setViewerFailed] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1100px)').matches
  );
  const [downloading, setDownloading] = useState(false);
  const [actionError, setActionError] = useState('');

  useFocusTrap(overlayRef, true);

  // The page behind must not scroll while the viewer is open.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const close = useCallback(() => onClose(doc), [onClose, doc]);

  // Locking the vault (or a session ending) closes the viewer and drops the bytes.
  useEffect(
    () =>
      subscribeToken((token) => {
        if (!token) {
          bytesRef.current = null;
          onClose(null);
        }
      }),
    [onClose]
  );

  useEffect(() => {
    if (!doc) return undefined;
    setViewerFailed(false);
    setActionError('');
    bytesRef.current = null;
    nameRef.current = null;
    if (typeof doc.size === 'number' && doc.size > MAX_PREVIEW_BYTES) {
      setState({ status: 'toolarge' });
      return undefined;
    }
    setState({ status: 'loading' });
    const controller = new AbortController();
    fetchDocumentBytes(doc.id, { signal: controller.signal })
      .then(({ bytes, filename }) => {
        bytesRef.current = bytes;
        nameRef.current = filename;
        const sniff = sniffPreviewType(bytes);
        setState({ status: 'ready', bytes, sniff });
        onLoaded?.(doc, bytes, sniff);
      })
      .catch((err) => {
        if (axios.isCancel(err) || err?.code === 'ERR_CANCELED') return;
        setState({ status: 'error' });
      });
    return () => {
      controller.abort();
      bytesRef.current = null;
    };
  }, [doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = useCallback(
    (delta) => {
      const next = index + delta;
      if (next >= 0 && next < files.length) onIndexChange(next);
    },
    [index, files.length, onIndexChange]
  );

  useEffect(() => {
    const onKeyDown = (event) => {
      if (!isTopDialog(overlayRef.current)) return;
      if (event.key === 'Escape') {
        close();
      } else if (!isEditable(event.target) && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          go(-1);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          go(1);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [go, close]);

  // The file went away under us (trashed from here): the parent already moved on.
  if (!doc) return null;

  const handleDownload = async () => {
    setDownloading(true);
    setActionError('');
    try {
      let bytes = bytesRef.current;
      let name = nameRef.current;
      if (!bytes) {
        ({ bytes, filename: name } = await fetchDocumentBytes(doc.id, { purpose: 'download' }));
      } else {
        // Saved from what the preview already holds: tell the server so it still counts as a download.
        recordDownload(doc.id);
      }
      downloadBytes(bytes, name ?? doc.filename);
    } catch {
      setActionError('Download failed. Please try again.');
    } finally {
      setDownloading(false);
    }
  };

  const handleTrash = async () => {
    setActionError('');
    try {
      await onTrash(doc);
    } catch {
      setActionError('Couldn’t move this file to Trash.');
    }
  };

  const sniff = state.status === 'ready' ? state.sniff : null;
  let body;
  if (state.status === 'loading') {
    body = <p className={styles.stageNote} role="status">Decrypting…</p>;
  } else if (state.status === 'toolarge' || state.status === 'error') {
    body = <NoPreview name={doc.filename} reason={REASONS[state.status]} onDownload={handleDownload} busy={downloading} />;
  } else if (viewerFailed) {
    body = <NoPreview name={doc.filename} reason={REASONS.failed} onDownload={handleDownload} busy={downloading} />;
  } else {
    const fail = () => setViewerFailed(true);
    switch (sniff.kind) {
      case 'image':
        body = <ImageViewer key={doc.id} bytes={state.bytes} mime={sniff.mime} name={doc.filename} onFail={fail} />;
        break;
      case 'pdf':
        body = <PdfViewer key={doc.id} bytes={state.bytes} name={doc.filename} onFail={fail} />;
        break;
      case 'text':
        body = <TextViewer key={doc.id} bytes={state.bytes} />;
        break;
      case 'audio':
      case 'video':
        body = <MediaViewer key={doc.id} bytes={state.bytes} mime={sniff.mime} kind={sniff.kind} name={doc.filename} onFail={fail} />;
        break;
      case 'docx':
        body = <DocxViewer key={doc.id} bytes={state.bytes} name={doc.filename} onFail={fail} />;
        break;
      default:
        body = (
          <NoPreview
            name={doc.filename}
            reason={sniff.kind === 'markup' ? REASONS.markup : sniff.note || REASONS.none}
            onDownload={handleDownload}
            busy={downloading}
          />
        );
    }
  }

  return (
    <div
      ref={overlayRef}
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${doc.filename}`}
    >
      <header className={styles.topBar}>
        <div className={styles.titleBlock}>
          <h2 className={styles.title} title={doc.filename}>
            {doc.filename}
          </h2>
          <span className={styles.counter}>
            {index + 1} of {files.length}
          </span>
        </div>
        <div className={styles.topActions}>
          <button type="button" onClick={handleDownload} disabled={downloading} aria-label="Download">
            <DownloadSimple size={20} />
            <span>Download</span>
          </button>
          <button type="button" onClick={() => onShare(doc)} aria-label="Share">
            <ShareNetwork size={20} />
            <span>Share</span>
          </button>
          <button type="button" onClick={() => onRename(doc)} aria-label="Rename">
            <PencilSimple size={20} />
            <span>Rename</span>
          </button>
          <button type="button" onClick={handleTrash} aria-label="Move to trash">
            <Trash size={20} />
            <span>Move to trash</span>
          </button>
          <button
            type="button"
            onClick={() => setDetailsOpen((open) => !open)}
            aria-pressed={detailsOpen}
            aria-label="Details"
          >
            <Info size={20} />
            <span>Details</span>
          </button>
          <button type="button" onClick={close} aria-label="Close preview" className={styles.closeButton}>
            <X size={20} />
          </button>
        </div>
      </header>

      <div className={styles.main}>
        <div className={styles.stage}>
          {actionError && (
            <p className={styles.actionError} role="alert">
              {actionError}
            </p>
          )}
          {body}
          {index > 0 && (
            <button type="button" className={`${styles.nav} ${styles.navPrev}`} onClick={() => go(-1)} aria-label="Previous file">
              <CaretLeft size={24} weight="bold" />
            </button>
          )}
          {index < files.length - 1 && (
            <button type="button" className={`${styles.nav} ${styles.navNext}`} onClick={() => go(1)} aria-label="Next file">
              <CaretRight size={24} weight="bold" />
            </button>
          )}
        </div>

        {detailsOpen && (
          <aside className={styles.details} aria-label="File details">
            <h3 className={styles.detailsTitle}>Details</h3>
            <dl>
              <div>
                <dt>Name</dt>
                <dd>{doc.filename}</dd>
              </div>
              <div>
                <dt>Type</dt>
                <dd>{describeType(sniff)}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>{typeof doc.size === 'number' ? formatBytes(doc.size) : '—'}</dd>
              </div>
              <div>
                <dt>Modified</dt>
                <dd>{formatDateTime(doc.updatedAt || doc.createdAt)}</dd>
              </div>
              <div>
                <dt>Folder</dt>
                <dd>{!doc.folder || doc.folder === 'root' ? 'My files' : doc.folder}</dd>
              </div>
            </dl>
          </aside>
        )}
      </div>
    </div>
  );
}

export default FilePreview;
