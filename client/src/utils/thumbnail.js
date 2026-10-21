export const THUMB_MAX_DIMENSION = 320;
export const THUMB_TARGET_BYTES = 30 * 1024;
const QUALITY_STEPS = [0.7, 0.6, 0.5, 0.4, 0.3];
const SHRINK_STEPS = [1, 0.8, 0.65];
const GENERATION_TIMEOUT_MS = 15000;
export const THUMB_SOURCE_MAX_BYTES = 4 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

function extensionOf(name = '') {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

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

function drawScaled(source, sourceWidth, sourceHeight, bound) {
  const scale = Math.min(1, bound / Math.max(sourceWidth, sourceHeight));
  const canvas = makeCanvas(sourceWidth * scale, sourceHeight * scale);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function encodeUnderTarget(source, sourceWidth, sourceHeight) {
  for (const shrink of SHRINK_STEPS) {
    const canvas = drawScaled(source, sourceWidth, sourceHeight, THUMB_MAX_DIMENSION * shrink);
    for (const type of ['image/webp', 'image/jpeg']) {
      let usable = false;
      for (const quality of QUALITY_STEPS) {
        const blob = await toBlob(canvas, type, quality);
        if (!blob || blob.type !== type) break;
        usable = true;
        if (blob.size <= THUMB_TARGET_BYTES) return blob;
      }
      if (usable) break;
    }
  }
  return null;
}

async function fromImage(file) {
  const bitmap = await createImageBitmap(file);
  try {
    return await encodeUnderTarget(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close?.();
  }
}

async function fromPdf(file) {
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

export async function generateThumbnail(file, { name } = {}) {
  const kind = thumbnailKind(name ?? file.name, file.type);
  if (!kind) return null;
  return (await thumbnailResult(file, kind)).blob ?? null;
}

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
    return { reason: 'decode-failed' };
  } finally {
    clearTimeout(timer);
    work.catch(() => {});
  }
}
