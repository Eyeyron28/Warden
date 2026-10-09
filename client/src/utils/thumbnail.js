/**
 * Browser-side preview thumbnails, drawn from the plaintext file BEFORE it
 * leaves the page. Only the finished thumbnail is sent (alongside the
 * upload) and the server encrypts it - see server/utils/thumbnails.js.
 *
 * Images: decoded and redrawn to a canvas, which re-encodes the pixels, so
 * EXIF/metadata is dropped by construction. PDFs: page 1 only, rendered
 * with pdfjs-dist, which is dynamically imported here and never part of
 * the initial bundle. Everything else gets no thumbnail (the UI shows a
 * type icon instead).
 *
 * Everything in this file is best-effort: generateThumbnail never throws
 * and never logs file content - a failure just means "no thumbnail".
 */

export const THUMB_MAX_DIMENSION = 320;
export const THUMB_TARGET_BYTES = 30 * 1024;
const QUALITY_STEPS = [0.7, 0.6, 0.5, 0.4, 0.3];
const SHRINK_STEPS = [1, 0.8, 0.65]; // fractions of the full 320px bound
const GENERATION_TIMEOUT_MS = 15000;
export const THUMB_SOURCE_MAX_BYTES = 4 * 1024 * 1024; // same cap as uploads

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

function extensionOf(name = '') {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/** 'image' | 'pdf' | null - whether (and how) a thumbnail can be drawn. */
export function thumbnailKind(name, type = '') {
  const ext = extensionOf(name);
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)) return 'image';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return null;
}

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality));
}

/** Draws `source` into a canvas whose longest side is at most `bound` (never upscaling). */
function drawScaled(source, sourceWidth, sourceHeight, bound) {
  const scale = Math.min(1, bound / Math.max(sourceWidth, sourceHeight));
  const canvas = makeCanvas(sourceWidth * scale, sourceHeight * scale);
  const context = canvas.getContext('2d');
  // JPEG has no alpha, and a flat white page is the right backdrop for both
  // transparent PNGs and PDF pages.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Encodes to WebP (JPEG if the browser can't), lowering quality and then
 * dimensions in steps until it fits the byte target. null if it never does.
 */
async function encodeUnderTarget(source, sourceWidth, sourceHeight) {
  for (const shrink of SHRINK_STEPS) {
    const canvas = drawScaled(source, sourceWidth, sourceHeight, THUMB_MAX_DIMENSION * shrink);
    for (const type of ['image/webp', 'image/jpeg']) {
      let usable = false;
      for (const quality of QUALITY_STEPS) {
        const blob = await toBlob(canvas, type, quality);
        // A browser without WebP encoding silently hands back PNG instead.
        if (!blob || blob.type !== type) break;
        usable = true;
        if (blob.size <= THUMB_TARGET_BYTES) return blob;
      }
      if (usable) break; // this type works but is too big here: shrink, don't switch format
    }
  }
  return null;
}

async function fromImage(file) {
  const bitmap = await createImageBitmap(file); // first frame for GIFs
  try {
    return await encodeUnderTarget(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close?.();
  }
}

async function fromPdf(file) {
  // Loaded only when a PDF is actually being thumbnailed: this import (and
  // the worker URL) become their own chunks, outside the initial load.
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({ data, isEvalSupported: false });
  const pdf = await loadingTask.promise;
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = THUMB_MAX_DIMENSION / Math.max(base.width, base.height);
    const viewport = page.getViewport({ scale });
    const canvas = makeCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    return await encodeUnderTarget(canvas, canvas.width, canvas.height);
  } finally {
    pdf.destroy();
  }
}

/**
 * @param {Blob|File} file the plaintext file
 * @param {{ name?: string }} [options] filename, when `file` is a bare Blob
 * @returns {Promise<Blob|null>} a WebP/JPEG thumbnail of at most ~30KB, or null
 */
export async function generateThumbnail(file, { name } = {}) {
  const kind = thumbnailKind(name ?? file.name, file.type);
  if (!kind) return null;
  return (await thumbnailResult(file, kind)).blob ?? null;
}

/**
 * Draws a thumbnail for a file whose KIND is already known (decided from its bytes by the
 * caller, not from a name) and says WHY when it cannot: never throws.
 *
 * @param {Blob|File} file the plaintext file
 * @param {'image'|'pdf'} kind
 * @returns {Promise<{ blob: Blob } | { reason: 'too-large'|'decode-failed'|'timeout'|'too-big-result' }>}
 */
export async function thumbnailResult(file, kind) {
  if (file.size > THUMB_SOURCE_MAX_BYTES) return { reason: 'too-large' };
  let work;
  try {
    work = kind === 'pdf' ? fromPdf(file) : fromImage(file);
  } catch {
    return { reason: 'decode-failed' };
  }
  let timer;
  const TIMED_OUT = Symbol('timeout');
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), GENERATION_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([work, timeout]);
    if (outcome === TIMED_OUT) return { reason: 'timeout' };
    return outcome ? { blob: outcome } : { reason: 'too-big-result' };
  } catch {
    // Corrupt, unsupported or encrypted file.
    return { reason: 'decode-failed' };
  } finally {
    clearTimeout(timer);
    // If the timeout won, the abandoned work may still reject later.
    work.catch(() => {});
  }
}
