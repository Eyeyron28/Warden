import { MAX_SIDE, cropToPixels, documentFilter, fitWithin, isFullCrop, normalizeRotation, rotatedSize } from './imageOps.js';

export const releaseCanvas = (canvas) => {
  if (canvas) {
    canvas.width = 0;
    canvas.height = 0;
  }
};

const contextOf = (canvas) => canvas.getContext('2d', { willReadFrequently: true });

const newCanvas = (width, height) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return createImageBitmap(file);
  }
}

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

export function renderRotated(work, rotation, maxSide = Infinity) {
  const turn = normalizeRotation(rotation);
  const full = rotatedSize(work.width, work.height, turn);
  const { width, height } = fitWithin(full.width, full.height, maxSide);
  const canvas = newCanvas(width, height);
  const context = contextOf(canvas);
  context.imageSmoothingQuality = 'high';
  context.translate(width / 2, height / 2);
  context.rotate((turn * Math.PI) / 180);
  const drawWidth = turn % 180 === 0 ? width : height;
  const drawHeight = turn % 180 === 0 ? height : width;
  context.drawImage(work, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  return canvas;
}

export function applyDocumentMode(canvas, threshold) {
  const context = contextOf(canvas);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  documentFilter(image, { threshold });
  context.putImageData(image, 0, 0);
}

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
