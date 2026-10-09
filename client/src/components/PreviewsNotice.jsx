import { reasonLabel, summarizePreviews } from '../utils/previewWork.js';
import styles from './PreviewsNotice.module.css';

/**
 * A small, non-blocking line on My files about previews:
 *  - files without a preview exist  -> "Generate previews for N files" [Generate]
 *  - running                        -> progress and Pause (two files at a time, in the background)
 *  - finished                       -> "12 done, 2 could not be previewed" with each reason
 *  - earlier failures on record     -> "2 files could not be previewed" [Try again]
 * Nothing starts by itself: previews download and decrypt each file, so the person chooses.
 */
function PreviewsNotice({ generator, documents, onRetried }) {
  const { phase, progress, candidates, failedBefore, start, pause, resume, dismiss, retryFailed } = generator;
  const nameOf = (id) => documents.find((doc) => doc.id === id)?.filename || 'A file';

  const list = (entries) => (
    <details className={styles.details}>
      <summary>Why?</summary>
      <ul>
        {entries.map(({ id, reason }) => (
          <li key={id}>
            <strong>{nameOf(id)}</strong> - {reasonLabel(reason)}
          </li>
        ))}
      </ul>
    </details>
  );

  if (phase === 'running' || phase === 'pausing' || phase === 'paused') {
    const finished = progress.done + progress.failures.length;
    return (
      <div className={styles.notice} role="status" aria-live="polite">
        <span className={styles.text}>
          {phase === 'paused' ? 'Previews paused' : 'Making previews'} - {finished} of {progress.total}
          {progress.failures.length > 0 && ` (${progress.failures.length} could not be previewed)`}
        </span>
        <progress className={styles.bar} max={progress.total || 1} value={finished} aria-label="Preview progress" />
        {phase === 'paused' ? (
          <button type="button" className={styles.button} onClick={resume}>
            Resume
          </button>
        ) : (
          <button type="button" className={styles.button} onClick={pause} disabled={phase === 'pausing'}>
            {phase === 'pausing' ? 'Pausing…' : 'Pause'}
          </button>
        )}
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div className={styles.notice} role="status" aria-live="polite">
        <span className={styles.text}>{summarizePreviews(progress.done, progress.failures.length)}</span>
        {progress.failures.length > 0 && list(progress.failures)}
        <button type="button" className={styles.button} onClick={dismiss}>
          OK
        </button>
      </div>
    );
  }

  if (candidates.length > 0) {
    return (
      <div className={styles.notice} role="status">
        <span className={styles.text}>
          Generate previews for {candidates.length} file{candidates.length === 1 ? '' : 's'}
        </span>
        <span className={styles.hint}>Each file is downloaded and drawn here, two at a time.</span>
        <button type="button" className={styles.button} onClick={start}>
          Generate
        </button>
      </div>
    );
  }

  if (failedBefore.length > 0) {
    return (
      <div className={styles.notice} role="status">
        <span className={styles.text}>
          {failedBefore.length} file{failedBefore.length === 1 ? '' : 's'} could not be previewed
        </span>
        {list(failedBefore.map((doc) => ({ id: doc.id, reason: doc.thumbFailReason })))}
        <button
          type="button"
          className={styles.button}
          onClick={async () => {
            await retryFailed();
            onRetried?.();
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  return null;
}

export default PreviewsNotice;
