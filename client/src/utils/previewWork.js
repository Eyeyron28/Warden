import { sniffPreviewType } from './previewType.js';

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

export function isPreviewCandidate(doc) {
  if (!doc || doc.hasThumb || doc.thumbFailed) return false;
  if (Number.isFinite(doc.size) && doc.size > PREVIEW_MAX_BYTES) return false;
  return doc.previewKind == null || doc.previewKind === 'image' || doc.previewKind === 'pdf';
}

export function previewKindOfBytes(bytes) {
  const { kind } = sniffPreviewType(bytes);
  return kind === 'image' || kind === 'pdf' ? kind : 'none';
}

export const failedPreviews = (documents) => documents.filter((doc) => doc.thumbFailed && !doc.hasThumb);

export async function previewOne(doc, { fetchBytes, drawThumbnail, uploadThumbnail, recordFailure, signal }) {
  const fail = async (reason, kind) => {
    let recorded = true;
    try {
      await recordFailure(doc.id, reason, kind);
    } catch {
      recorded = false;
    }
    return { id: doc.id, status: 'failed', reason, recorded };
  };

  let bytes;
  try {
    ({ bytes } = await fetchBytes(doc.id, { signal }));
  } catch (error) {
    if (signal?.aborted || error?.response?.status === 401) throw error;
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
    return fail(error?.response?.status === 400 ? 'too-big-result' : 'download-failed', kind);
  }
  return { id: doc.id, status: 'done' };
}

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
        return;
      }
      if (result.status === 'done') done += 1;
      else failures.push({ id: result.id, reason: result.reason });
      onResult(result);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { done, failures, finished: next >= queue.length };
}

export function summarizePreviews(done, failedCount) {
  if (!failedCount) return `${done} done`;
  return `${done} done, ${failedCount} could not be previewed`;
}
