import { useRef, useState } from 'react';

import { fetchDocumentBlob, putThumbnail } from '../services/documentsService.js';
import { generateThumbnail, THUMB_SOURCE_MAX_BYTES, thumbnailKind } from '../utils/thumbnail.js';
import styles from './PreviewsPanel.module.css';

/**
 * Adds previews to documents uploaded before previews existed. There is no
 * background work anywhere: this runs only when the person starts it, one
 * document at a time, and each one is downloaded and decrypted in full to
 * draw its thumbnail - hence the bandwidth warning. Cancellable between
 * documents. Only images and PDFs can have a preview, and only files up to
 * the 4MB upload cap are processed.
 */
function PreviewsPanel({ documents, onThumbnailAdded, onClose }) {
  const candidates = documents.filter((doc) => !doc.hasThumb && thumbnailKind(doc.filename));

  // Snapshot taken when the run starts: `documents` changes as each preview
  // lands, and the "n of N" count must not shrink underneath the person.
  const [queue, setQueue] = useState([]);
  const [phase, setPhase] = useState('idle'); // idle | running | done
  const [progress, setProgress] = useState({ index: 0, created: 0, skipped: 0 });
  const cancelRef = useRef(false);

  const handleStart = async () => {
    cancelRef.current = false;
    const list = candidates;
    setQueue(list);
    setPhase('running');
    let created = 0;
    let skipped = 0;
    for (let index = 0; index < list.length; index += 1) {
      if (cancelRef.current) break;
      setProgress({ index, created, skipped });
      const doc = list[index];
      try {
        const { blob } = await fetchDocumentBlob(doc.id);
        const thumb =
          blob.size <= THUMB_SOURCE_MAX_BYTES ? await generateThumbnail(blob, { name: doc.filename }) : null;
        if (thumb) {
          await putThumbnail(doc.id, thumb);
          onThumbnailAdded(doc.id);
          created += 1;
        } else {
          skipped += 1;
        }
      } catch {
        // One document failing (or the session ending) shouldn't stop the
        // rest; an expired session fails every remaining call the same way.
        skipped += 1;
      }
    }
    setProgress({ index: list.length, created, skipped });
    setPhase('done');
  };

  if (phase === 'running') {
    const shown = Math.min(progress.index + 1, queue.length);
    return (
      <div className={styles.panel}>
        <p className={styles.status} role="status" aria-live="polite">
          Processing {shown} of {queue.length}…
        </p>
        <progress className={styles.bar} max={queue.length} value={progress.index} />
        <div className={styles.buttonRow}>
          <button
            type="button"
            className={styles.cancelButton}
            onClick={() => {
              cancelRef.current = true;
            }}
          >
            Stop after this one
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div className={styles.panel}>
        <p className={styles.status} role="status">
          {cancelRef.current ? 'Stopped. ' : ''}
          {progress.created} preview{progress.created === 1 ? '' : 's'} created
          {progress.skipped > 0 ? `, ${progress.skipped} skipped (no preview could be drawn)` : ''}.
        </p>
        <div className={styles.buttonRow}>
          <button type="button" className={styles.submitButton} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <p className={styles.body}>
        {candidates.length === 0
          ? 'Every image and PDF in your vault already has a preview.'
          : `${candidates.length} image or PDF document${candidates.length === 1 ? ' has' : 's have'} no preview yet.`}
      </p>
      <p className={styles.helper}>
        To draw a preview, each file is downloaded and decrypted in this browser tab, so this uses data in
        proportion to the files involved (4MB at most each). It runs one file at a time, only while this window
        is open, and you can stop it at any point.
      </p>
      <div className={styles.buttonRow}>
        <button type="button" className={styles.cancelButton} onClick={onClose}>
          Close
        </button>
        <button type="button" className={styles.submitButton} onClick={handleStart} disabled={candidates.length === 0}>
          Generate previews
        </button>
      </div>
    </div>
  );
}

export default PreviewsPanel;
