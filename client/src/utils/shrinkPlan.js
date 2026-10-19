// "Make it smaller": the plan for re-encoding a photo that is over the upload limit. Pure, so it can be tested without a browser.

export const MAX_INPUT_BYTES = 60 * 1024 * 1024;
export const MAX_PIXELS = 100 * 1000 * 1000;
export const TARGET_SHARE = 0.9;

// Quality first, then a smaller picture. Each step starts again from the original, and the first result that fits wins.
export const SHRINK_STEPS = [
  { quality: 0.85, maxSide: null },
  { quality: 0.75, maxSide: null },
  { quality: 0.65, maxSide: null },
  { quality: 0.55, maxSide: null },
  { quality: 0.75, maxSide: 4000 },
  { quality: 0.75, maxSide: 3000 },
  { quality: 0.75, maxSide: 2400 },
  { quality: 0.75, maxSide: 1800 },
];

/** The size the result has to be at or under: 90 percent of the limit. */
export const shrinkTarget = (limitBytes) => Math.floor(limitBytes * TARGET_SHARE);

const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PHOTO_EXTENSION = /\.(jpe?g|png|webp)$/i;

/** A JPEG, PNG or WebP photo (by type, or by extension when the browser gives no type). */
export const isShrinkablePhoto = (file) => PHOTO_TYPES.has(String(file?.type || '').toLowerCase()) || (!file?.type && PHOTO_EXTENSION.test(String(file?.name || '')));

/** Offered only for a supported photo that is over the limit and not absurdly large. */
export const canShrink = (file, limitBytes) => Boolean(file) && isShrinkablePhoto(file) && file.size > limitBytes && file.size <= MAX_INPUT_BYTES;

/**
 * The new name: the base name with .jpg. A last extension is replaced, other dots in the base become dashes (so a name like
 * "scan.exe.png" can never read as a double extension), and a name without an extension just gets .jpg.
 */
export function shrinkName(name) {
  const clean = String(name || '').trim();
  const base = clean.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/\./g, '-').trim();
  return `${base || 'photo'}.jpg`;
}

/** The size to draw at for a step (never larger than the original). */
export function stepSize(width, height, maxSide) {
  const longest = Math.max(width, height);
  if (!maxSide || longest <= maxSide) return { width, height };
  const scale = maxSide / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
