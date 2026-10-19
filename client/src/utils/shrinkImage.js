import { MAX_INPUT_BYTES, MAX_PIXELS, SHRINK_STEPS, shrinkName, shrinkTarget, stepSize } from './shrinkPlan.js';

// Loaded only when someone presses "Make it smaller". Everything happens in this tab; the original file is never changed.

export const CANNOT_DECODE = 'This browser cannot shrink this photo. Open it in your Photos app and export it as JPEG, then try again.';
export const CANNOT_FIT = 'Could not make this image small enough.';
export const CANNOT_SAVE = 'This browser could not save a smaller version of this photo.';

const toBlob = (canvas, quality) =>
  new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob || null), 'image/jpeg', quality);
    } catch {
      resolve(null);
    }
  });

/**
 * Reads the photo with the camera's rotation applied. createImageBitmap with the orientation option is tried first; some
 * browsers reject that option (or the whole call), so an <img> element is next (browsers rotate those by themselves), and a
 * plain createImageBitmap is the last try. Returns null when none of them can read the file (for example a HEIC photo in a
 * browser that cannot open it).
 */
async function decode(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
  } catch {
    // fall through to the next way
  }
  if (typeof Image !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) };
      }
    } catch {
      // fall through
    }
    URL.revokeObjectURL(url);
  }
  try {
    const bitmap = await createImageBitmap(file);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
  } catch {
    return null;
  }
}

/**
 * Re-encodes a photo as a JPEG at or under 90 percent of the limit, and always smaller than the original. The picture is
 * never drawn larger than 4096 px on its long side (phones refuse bigger canvases and give a blank picture).
 * @returns {Promise<{ ok: true, file: File, width: number, height: number } | { ok: false, message: string }>}
 */
export async function shrinkToJpeg(file, limitBytes) {
  if (file.size > MAX_INPUT_BYTES) return { ok: false, message: 'This image is too large to shrink here.' };
  let picture = null;
  let canvas;
  try {
    picture = await decode(file);
    if (!picture) return { ok: false, message: CANNOT_DECODE };
    if (picture.width * picture.height > MAX_PIXELS) return { ok: false, message: 'This image has too many pixels to shrink here.' };
    const target = shrinkTarget(limitBytes);
    canvas = document.createElement('canvas');
    let anyBlob = false;
    for (const step of SHRINK_STEPS) {
      const { width, height } = stepSize(picture.width, picture.height, step.maxSide);
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return { ok: false, message: CANNOT_SAVE };
      context.fillStyle = '#ffffff'; // transparent areas become white in a JPEG
      context.fillRect(0, 0, width, height);
      context.drawImage(picture.source, 0, 0, width, height);
      // eslint-disable-next-line no-await-in-loop
      const blob = await toBlob(canvas, step.quality);
      if (blob) anyBlob = true;
      if (blob && blob.size <= target && blob.size < file.size) {
        return { ok: true, file: new File([blob], shrinkName(file.name), { type: 'image/jpeg', lastModified: Date.now() }), width, height };
      }
    }
    return { ok: false, message: anyBlob ? CANNOT_FIT : CANNOT_SAVE };
  } catch {
    return { ok: false, message: CANNOT_DECODE };
  } finally {
    picture?.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
