import { useEffect, useRef, useState } from 'react';
import { CaretLeft, CaretRight, MagnifyingGlassMinus, MagnifyingGlassPlus } from '@phosphor-icons/react';

import styles from './Preview.module.css';

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/**
 * A PDF drawn to a canvas with pdfjs-dist (loaded only when a PDF is opened,
 * the same dynamic import the thumbnail code uses). Only the canvas is shown:
 * no links, forms or scripts from the document are ever active. One page at a
 * time, with page buttons, PageUp/PageDown, and zoom.
 */
function PdfViewer({ bytes, onFail }) {
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const [pdf, setPdf] = useState(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoomIndex, setZoomIndex] = useState(2);
  const [width, setWidth] = useState(0);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let task = null;
    (async () => {
      const [pdfjs, worker] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ]);
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      // pdf.js takes ownership of the buffer it is given: hand it a copy.
      task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, enableXfa: false });
      const loaded = await task.promise;
      if (cancelled) {
        loaded.destroy();
        return;
      }
      setPdf(loaded);
      setPageNumber(1);
    })().catch(() => {
      if (!cancelled) onFail();
    });
    return () => {
      cancelled = true;
      task?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(stage);
    setWidth(stage.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!pdf || !canvasRef.current || width === 0) return undefined;
    let cancelled = false;
    let renderTask = null;
    setRendering(true);
    (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const fit = Math.max(120, width - 24) / base.width;
      const scale = fit * ZOOM_STEPS[zoomIndex];
      const viewport = page.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = canvasRef.current;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const context = canvas.getContext('2d');
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      renderTask = page.render({ canvasContext: context, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await renderTask.promise;
      if (!cancelled) setRendering(false);
    })().catch((err) => {
      if (!cancelled && err?.name !== 'RenderingCancelledException') onFail();
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, pageNumber, zoomIndex, width]);

  const pages = pdf?.numPages ?? 0;
  const go = (delta) => setPageNumber((current) => Math.min(pages, Math.max(1, current + delta)));

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
      if (event.key === 'PageDown') go(1);
      else if (event.key === 'PageUp') go(-1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  return (
    <div className={styles.pdfWrap}>
      <div ref={stageRef} className={styles.pdfStage}>
        <canvas ref={canvasRef} className={styles.pdfCanvas} aria-label="PDF page" role="img" />
        {!pdf && <p className={styles.stageNote}>Opening PDF…</p>}
      </div>
      {pdf && (
        <div className={styles.zoomBar} role="group" aria-label="PDF controls">
          <button type="button" onClick={() => go(-1)} disabled={pageNumber <= 1} aria-label="Previous page">
            <CaretLeft size={18} />
          </button>
          <span aria-live="polite">
            Page{' '}
            <input
              type="number"
              min={1}
              max={pages}
              value={pageNumber}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isInteger(value) && value >= 1 && value <= pages) setPageNumber(value);
              }}
              className={styles.pageInput}
              aria-label="Page number"
            />{' '}
            of {pages}
          </span>
          <button type="button" onClick={() => go(1)} disabled={pageNumber >= pages} aria-label="Next page">
            <CaretRight size={18} />
          </button>
          <span className={styles.divider} aria-hidden="true" />
          <button type="button" onClick={() => setZoomIndex((i) => Math.max(0, i - 1))} disabled={zoomIndex === 0} aria-label="Zoom out">
            <MagnifyingGlassMinus size={18} />
          </button>
          <span>{Math.round(ZOOM_STEPS[zoomIndex] * 100)}%</span>
          <button
            type="button"
            onClick={() => setZoomIndex((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))}
            disabled={zoomIndex === ZOOM_STEPS.length - 1}
            aria-label="Zoom in"
          >
            <MagnifyingGlassPlus size={18} />
          </button>
        </div>
      )}
      {rendering && pdf && <span className={styles.srOnly} role="status">Loading page</span>}
    </div>
  );
}

export default PdfViewer;
