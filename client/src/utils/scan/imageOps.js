/**
 * The arithmetic of the scanner, kept free of the DOM so it can be tested: sizes, rotation, the crop rectangle and its handles, and
 * the "Document mode" pixel filter. A crop is {x, y, w, h} as fractions (0 to 1) of the ROTATED image.
 */

// The longest side of a scanned page, in pixels: legible text, and small enough for the 4 MB cap.
export const MAX_SIDE = 2000;
export const MIN_CROP = 0.05;
export const FULL_CROP = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Scales (width, height) down so the longest side is at most `max`; never scales up. */
export function fitWithin(width, height, max = MAX_SIDE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export const normalizeRotation = (degrees) => ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;

/** The size of an image after it is turned `degrees` (a multiple of 90). */
export function rotatedSize(width, height, degrees) {
  return normalizeRotation(degrees) % 180 === 0 ? { width, height } : { width: height, height: width };
}

/** Keeps a crop inside the picture and at least MIN_CROP wide and high. */
export function clampCrop(rect) {
  const w = clamp(rect.w, MIN_CROP, 1);
  const h = clamp(rect.h, MIN_CROP, 1);
  return { x: clamp(rect.x, 0, 1 - w), y: clamp(rect.y, 0, 1 - h), w, h };
}

/**
 * Moves one handle of the crop ('move' = the whole rectangle; 'nw', 'ne', 'sw', 'se' = a corner) by a change (dx, dy) given as
 * fractions of the picture. The opposite corner stays where it is.
 */
export function applyHandle(rect, handle, dx, dy) {
  if (handle === 'move') return clampCrop({ ...rect, x: rect.x + dx, y: rect.y + dy });
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.w;
  let bottom = rect.y + rect.h;
  if (handle.includes('w')) left = clamp(left + dx, 0, right - MIN_CROP);
  if (handle.includes('e')) right = clamp(right + dx, left + MIN_CROP, 1);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - MIN_CROP);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + MIN_CROP, 1);
  return clampCrop({ x: left, y: top, w: right - left, h: bottom - top });
}

/** The crop follows the picture when it is turned a quarter turn: 'right' is clockwise. */
export function rotateCrop(rect, direction) {
  if (direction === 'right') return { x: 1 - (rect.y + rect.h), y: rect.x, w: rect.h, h: rect.w };
  return { x: rect.y, y: 1 - (rect.x + rect.w), w: rect.h, h: rect.w };
}

/** A crop in whole pixels of an image `width` x `height`; never empty. */
export function cropToPixels(rect, width, height) {
  const x = clamp(Math.round(rect.x * width), 0, width - 1);
  const y = clamp(Math.round(rect.y * height), 0, height - 1);
  return { x, y, width: clamp(Math.round(rect.w * width), 1, width - x), height: clamp(Math.round(rect.h * height), 1, height - y) };
}

export const isFullCrop = (rect) => rect.x <= 0.001 && rect.y <= 0.001 && rect.w >= 0.999 && rect.h >= 0.999;

/**
 * "Document mode", in place on image data ({ data, width, height }, RGBA): grayscale, then the contrast is stretched so the
 * darkest 1% of pixels become black and the lightest 1% white (a page photographed in poor light becomes white paper, black ink), and
 * with a threshold above 0 every pixel becomes pure black or white around that level (0 to 100).
 */
export function documentFilter(imageData, { threshold = 0 } = {}) {
  const { data } = imageData;
  const pixels = data.length / 4;
  const gray = new Uint8ClampedArray(pixels);
  const histogram = new Uint32Array(256);
  for (let i = 0; i < pixels; i += 1) {
    const value = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
    gray[i] = value;
    histogram[value] += 1;
  }
  const cut = Math.max(1, Math.floor(pixels * 0.01));
  let low = 0;
  let seen = 0;
  while (low < 255 && seen + histogram[low] <= cut) seen += histogram[low++];
  let high = 255;
  seen = 0;
  while (high > 0 && seen + histogram[high] <= cut) seen += histogram[high--];
  // A flat picture has nothing to stretch.
  if (high - low < 8) {
    low = 0;
    high = 255;
  }
  const level = clamp(Math.round(threshold * 2.55), 0, 255);
  const scale = 255 / (high - low);
  for (let i = 0; i < pixels; i += 1) {
    let value = clamp(Math.round((gray[i] - low) * scale), 0, 255);
    if (threshold > 0) value = value >= level ? 255 : 0;
    data[i * 4] = value;
    data[i * 4 + 1] = value;
    data[i * 4 + 2] = value;
    data[i * 4 + 3] = 255;
  }
  return imageData;
}

/** "Scan 2026-10-15 14.32" for a given moment (the person's own clock). */
export function defaultScanName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `Scan ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}`;
}

/** A name for the saved file(s): no path characters, not empty, not too long. */
export function cleanScanName(value) {
  const name = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.(pdf|jpe?g)$/i, '')
    .slice(0, 100)
    .trim();
  return name;
}
