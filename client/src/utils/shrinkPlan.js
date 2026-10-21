export const MAX_INPUT_BYTES = 60 * 1024 * 1024;
export const MAX_PIXELS = 100 * 1000 * 1000;
export const TARGET_SHARE = 0.9;

export const MAX_DRAW_SIDE = 4096;
export const SHRINK_STEPS = [
  { quality: 0.85, maxSide: MAX_DRAW_SIDE },
  { quality: 0.75, maxSide: MAX_DRAW_SIDE },
  { quality: 0.65, maxSide: MAX_DRAW_SIDE },
  { quality: 0.55, maxSide: MAX_DRAW_SIDE },
  { quality: 0.75, maxSide: 4000 },
  { quality: 0.75, maxSide: 3000 },
  { quality: 0.75, maxSide: 2400 },
  { quality: 0.75, maxSide: 1800 },
];

export const shrinkTarget = (limitBytes) => Math.floor(limitBytes * TARGET_SHARE);

const PHOTO_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const PHOTO_EXTENSION = /\.(jpe?g|png|webp|heic|heif)$/i;

export const isShrinkablePhoto = (file) => PHOTO_TYPES.has(String(file?.type || '').toLowerCase()) || (!file?.type && PHOTO_EXTENSION.test(String(file?.name || '')));

export const canShrink = (file, limitBytes) => Boolean(file) && isShrinkablePhoto(file) && file.size > limitBytes && file.size <= MAX_INPUT_BYTES;

export function shrinkName(name) {
  const clean = String(name || '').trim();
  const base = clean.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/\./g, '-').trim();
  return `${base || 'photo'}.jpg`;
}

export function stepSize(width, height, maxSide) {
  const longest = Math.max(width, height);
  if (!maxSide || longest <= maxSide) return { width, height };
  const scale = maxSide / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
