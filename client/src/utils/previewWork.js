import { sniffPreviewType } from './previewType.js';

/**
 * Which files get a preview, and what happens when one cannot be made.
 *
 * What a file is comes from its BYTES (utils/previewType.js), never its name, so an
 * extensionless "mod12" that is really a PDF works, and a ".png" that is really text does
 * not. Only png, jpeg, gif, webp and pdf are drawn: SVG and everything else (HEIC,
 * documents, audio...) are skipped with a reason, and a failure is recorded on the file
 * so it is not retried on every run.
 */

export const PREVIEW_MAX_BYTES = 4 * 1024 * 1024;
export const PREVIEW_CONCURRENCY = 2;

export const REASON_LABELS = Object.freeze({
  'unsupported-type': 'Not an image or PDF a preview can be drawn from',
  'decode-failed': 'The file looks like an image or PDF but could not be read (it may be damaged)',
  'too-large': 'Larger than the 4 MB previews are made from',
  'too-big-result': 'The preview could not be made small enough',
  timeout: 'Drawing the preview took too long',
  'download-failed': 'The file could not be fetched',
});

export const reasonLabel = (reason) => REASON_LABELS[reason] || 'The preview could not be made';

/**
 * Whether a listed file is worth trying: no preview yet, no earlier failure, not over the size cap,
 * and not already known (from its bytes) to be something that cannot have one. Files whose kind is
 * not known yet ("previewKind" null: older files, phone uploads, extensionless names) ARE tried -
 * the bytes decide once they are fetched.
 */
export function isPreviewCandidate(doc) {
  if (!doc || doc.hasThumb || doc.thumbFailed) return false;
  if (Number.isFinite(doc.size) && doc.size > PREVIEW_MAX_BYTES) return false;
  return doc.previewKind == null || doc.previewKind === 'image' || doc.previewKind === 'pdf';
}

/** 'image' | 'pdf' | 'none' for the bytes. SVG and anything else are 'none'. */
export function previewKindOfBytes(bytes) {
  const { kind } = sniffPreviewType(bytes);
  return kind === 'image' || kind === 'pdf' ? kind : 'none';
}

/** Files that failed before (recorded on the server), for the "could not be previewed" list. */
export const failedPreviews = (documents) => documents.filter((doc) => doc.thumbFailed && !doc.hasThumb);

/**
 * Makes (or fails to make) one preview. Dependencies are passed in so this is testable and the
 * page decides what "fetch" and "draw" are. Always resolves; never throws.
 *
 * @returns {Promise<{ id: string, status: 'done' } | { id: string, status: 'failed', reason: string, recorded: boolean }>}
 */
export async function previewOne(doc, { fetchBytes, drawThumbnail, uploadThumbnail, recordFailure, signal }) {
  const fail = async (reason, kind) => {
    let recorded = true;
    try {
      await recordFailure(doc.id, reason, kind);
    } catch {
      recorded = false; // e.g. the session ended: it will be tried again next time
    }
    return { id: doc.id, status: 'failed', reason, recorded };
  };

  let bytes;
  try {
    ({ bytes } = await fetchBytes(doc.id, { signal }));
  } catch (error) {
    if (signal?.aborted || error?.response?.status === 401) throw error; // stop everything: aborted, or the session ended
    return { id: doc.id, status: 'failed', reason: 'download-failed', recorded: false };
  }
  if (bytes.length > PREVIEW_MAX_BYTES) return fail('too-large');

  const kind = previewKindOfBytes(bytes);
  if (kind === 'none') return fail('unsupported-type', 'none');

  const result = await drawThumbnail(new Blob([bytes]), kind);
  if (!result.blob) return fail(result.reason, kind);
  try {
    await uploadThumbnail(doc.id, result.blob);
  } catch (error) {
    // The server refused it (size, type) or the session ended.
    return fail(error?.response?.status === 400 ? 'too-big-result' : 'download-failed', kind);
  }
  return { id: doc.id, status: 'done' };
}

/**
 * Works through `queue` with at most `concurrency` previews at a time. `shouldPause()` is checked
 * before each file starts, so Pause takes effect between files; `signal` stops it for good.
 *
 * @returns {Promise<{ done: number, failures: Array<{ id: string, reason: string }>, finished: boolean }>}
 */
export async function runPreviews(queue, deps, { concurrency = PREVIEW_CONCURRENCY, shouldPause = () => false, onResult = () => {}, signal } = {}) {
  let next = 0;
  let done = 0;
  const failures = [];
  const worker = async () => {
    while (next < queue.length && !signal?.aborted && !shouldPause()) {
      const doc = queue[next];
      next += 1;
      let result;
      try {
        // eslint-disable-next-line no-await-in-loop
        result = await previewOne(doc, { ...deps, signal });
      } catch {
        return; // aborted mid-file
      }
      if (result.status === 'done') done += 1;
      else failures.push({ id: result.id, reason: result.reason });
      onResult(result);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { done, failures, finished: next >= queue.length };
}

/** "12 done, 2 could not be previewed" (the second part only when there are failures). */
export function summarizePreviews(done, failedCount) {
  if (!failedCount) return `${done} done`;
  return `${done} done, ${failedCount} could not be previewed`;
}
