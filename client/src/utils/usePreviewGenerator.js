import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fetchDocumentBytes, markThumbnailFailed, putThumbnail, retryFailedThumbnails } from '../services/documentsService.js';
import { thumbnailResult } from './thumbnail.js';
import { failedPreviews, isPreviewCandidate, runPreviews } from './previewWork.js';

const deps = {
  // Drawing a preview is not the person opening the file: it counts as nothing.
  fetchBytes: (id) => fetchDocumentBytes(id, { purpose: 'silent' }),
  drawThumbnail: (blob, kind) => thumbnailResult(blob, kind),
  uploadThumbnail: putThumbnail,
  recordFailure: markThumbnailFailed,
};

/**
 * Background preview generation for My files, two files at a time, only while this page is open
 * (so only while the person is unlocked) and only after they press Generate. Pause takes effect
 * between files. Failures are recorded on the server (so a file is not retried every run) and
 * collected here for the summary.
 *
 * `onResult(result)` lets the page update its list: { id, status: 'done' } or
 * { id, status: 'failed', reason }.
 */
export function usePreviewGenerator({ documents, onResult }) {
  const candidates = useMemo(() => documents.filter(isPreviewCandidate), [documents]);
  const failedBefore = useMemo(() => failedPreviews(documents), [documents]);

  const [phase, setPhase] = useState('idle'); // idle | running | pausing | paused | done
  const [progress, setProgress] = useState({ done: 0, total: 0, failures: [] });
  const queueRef = useRef([]);
  const doneIdsRef = useRef(new Set());
  const pausedRef = useRef(false);
  const abortRef = useRef(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const work = useCallback(async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    pausedRef.current = false;
    setPhase('running');
    const remaining = queueRef.current.filter((doc) => !doneIdsRef.current.has(doc.id));
    const outcome = await runPreviews(remaining, deps, {
      signal: controller.signal,
      shouldPause: () => pausedRef.current,
      onResult: (result) => {
        doneIdsRef.current.add(result.id);
        setProgress((current) => ({
          ...current,
          done: current.done + (result.status === 'done' ? 1 : 0),
          failures: result.status === 'failed' ? [...current.failures, { id: result.id, reason: result.reason }] : current.failures,
        }));
        onResultRef.current?.(result);
      },
    });
    if (controller.signal.aborted) return;
    setPhase(outcome.finished ? 'done' : 'paused');
  }, []);

  const start = useCallback(() => {
    queueRef.current = candidates;
    doneIdsRef.current = new Set();
    setProgress({ done: 0, total: candidates.length, failures: [] });
    work();
  }, [candidates, work]);

  const pause = useCallback(() => {
    pausedRef.current = true;
    setPhase('pausing'); // the files already started finish first
  }, []);

  const resume = useCallback(() => work(), [work]);

  const dismiss = useCallback(() => {
    setPhase('idle');
    setProgress({ done: 0, total: 0, failures: [] });
  }, []);

  // "Try again" for files that failed before: forget the records, then the list shows them as candidates again.
  const retryFailed = useCallback(async () => {
    await retryFailedThumbnails();
    return true;
  }, []);

  // Leaving the page (or the session ending) stops the work.
  useEffect(() => () => abortRef.current?.abort(), []);

  return { phase, progress, candidates, failedBefore, start, pause, resume, dismiss, retryFailed };
}
