import { MAX_INPUT_BYTES, MAX_PIXELS, SHRINK_STEPS, shrinkName, shrinkTarget, stepSize } from './shrinkPlan.js';

// Loaded only when someone presses "Make it smaller". Everything happens in this tab; the original file is never changed.

const toBlob = (canvas, quality) => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

/**
 * Re-encodes a photo as a JPEG at or under 90 percent of the limit.
 * @returns {Promise<{ ok: true, file: File, width: number, height: number } | { ok: false, message: string }>}
 */
export async function shrinkToJpeg(file, limitBytes) {
  if (file.size > MAX_INPUT_BYTES) return { ok: false, message: 'This image is too large to shrink here.' };
  let bitmap;
  let canvas;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    if (bitmap.width * bitmap.height > MAX_PIXELS) return { ok: false, message: 'This image has too many pixels to shrink here.' };
    const target = shrinkTarget(limitBytes);
    canvas = document.createElement('canvas');
    for (const step of SHRINK_STEPS) {
      const { width, height } = stepSize(bitmap.width, bitmap.height, step.maxSide);
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff'; // transparent areas become white in a JPEG
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      // eslint-disable-next-line no-await-in-loop
      const blob = await toBlob(canvas, step.quality);
      if (blob && blob.size <= target) {
        return { ok: true, file: new File([blob], shrinkName(file.name), { type: 'image/jpeg', lastModified: Date.now() }), width, height };
      }
    }
    return { ok: false, message: 'Could not make this image small enough.' };
  } catch {
    return { ok: false, message: 'Could not read this image.' };
  } finally {
    bitmap?.close?.();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
