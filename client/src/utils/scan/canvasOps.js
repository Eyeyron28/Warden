import { MAX_SIDE, cropToPixels, documentFilter, fitWithin, isFullCrop, normalizeRotation, rotatedSize } from './imageOps.js';

/**
 * The browser side of the scanner: decoding a photo, turning it, cropping it, filtering it and encoding it as JPEG. Everything is
 * drawn with createImageBitmap and canvas - no <img>, no object URL, nothing written to any storage - and every canvas and bitmap
 * is released as soon as it is not needed (a canvas of width 0 holds no memory).
 */

export const releaseCanvas = (canvas) => {
  if (canvas) {
    canvas.width = 0;
    canvas.height = 0;
  }
};

// Pixels are read back from every working canvas (Document mode, the crop), so each says so when its context is made.
const contextOf = (canvas) => canvas.getContext('2d', { willReadFrequently: true });

const newCanvas = (width, height) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

/** Decodes a photo with its EXIF orientation applied, where the browser can. */
async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // An older browser that does not know the option (or the file): try without; a file that is not an image fails here too.
    return createImageBitmap(file);
  }
}

/**
 * Reads one photo into a working canvas whose longest side is at most MAX_SIDE (a 12-megapixel photo would otherwise take 48 MB of
 * memory per page), and closes the full-size bitmap straight away.
 */
export async function loadPage(file) {
  const bitmap = await decode(file);
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_SIDE);
    const work = newCanvas(width, height);
    const context = contextOf(work);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    return { work, width, height, original: { width: bitmap.width, height: bitmap.height } };
  } finally {
    bitmap.close?.();
  }
}

/** The working picture turned by `rotation`, optionally shrunk to `maxSide`. */
export function renderRotated(work, rotation, maxSide = Infinity) {
  const turn = normalizeRotation(rotation);
  const full = rotatedSize(work.width, work.height, turn);
  const { width, height } = fitWithin(full.width, full.height, maxSide);
  const canvas = newCanvas(width, height);
  const context = contextOf(canvas);
  context.imageSmoothingQuality = 'high';
  context.translate(width / 2, height / 2);
  context.rotate((turn * Math.PI) / 180);
  // The source is drawn centred, at the size it has before turning.
  const drawWidth = turn % 180 === 0 ? width : height;
  const drawHeight = turn % 180 === 0 ? height : width;
  context.drawImage(work, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  return canvas;
}

/** Document mode on a canvas, in place. */
export function applyDocumentMode(canvas, threshold) {
  const context = contextOf(canvas);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  documentFilter(image, { threshold });
  context.putImageData(image, 0, 0);
}

/** The finished page: turned, cropped, and in Document mode when it is on. The caller releases it. */
export function renderFinal(page) {
  const turned = renderRotated(page.work, page.rotation);
  let result = turned;
  if (!isFullCrop(page.crop)) {
    const box = cropToPixels(page.crop, turned.width, turned.height);
    result = newCanvas(box.width, box.height);
    contextOf(result).drawImage(turned, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
    releaseCanvas(turned);
  }
  if (page.documentMode) applyDocumentMode(result, page.threshold);
  return result;
}

/** A canvas as JPEG bytes. */
export function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          reject(new Error('This browser could not make a JPEG.'));
          return;
        }
        resolve(new Uint8Array(await blob.arrayBuffer()));
      },
      'image/jpeg',
      quality
    );
  });
}
