/**
 * The purpose watermark on a share link. It discourages reuse of a shared document ("For BDO account opening");
 * it cannot stop a screenshot, and it is not a security control. The purpose arrives inside the share's
 * encrypted manifest and is only ever used here, in the viewer's browser.
 */

export const WATERMARK_HINT = 'A watermark discourages reuse. It cannot stop a screenshot.';
export const PDF_DOWNLOAD_NOTE = 'Watermark applies to preview and image downloads.';

/** Image types whose downloads are stamped (gif would lose its animation, so it is left alone). */
const STAMPABLE = new Set(['image/png', 'image/jpeg', 'image/webp']);
export const isStampable = (mime) => STAMPABLE.has(mime);

/** "2026-10-09" -> "Oct 9, 2026" (the day the link was made; no time zone surprises). */
export function formatSharedDate(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** "<purpose> · shared <date> · Warden", or null when there is no purpose (then nothing is drawn at all). */
export function watermarkText({ purpose, sharedAt } = {}) {
  const clean = typeof purpose === 'string' ? purpose.trim() : '';
  if (!clean) return null;
  const date = formatSharedDate(sharedAt);
  return [clean, date ? `shared ${date}` : 'shared', 'Warden'].join(' · ');
}

/**
 * Draws `text` tiled and diagonal over a canvas context, semi-transparent. Pure drawing: used for the image
 * download stamp (and testable with a fake context).
 */
export function drawWatermark(ctx, width, height, text) {
  const fontSize = Math.max(14, Math.round(Math.min(width, height) / 22));
  ctx.save();
  ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const stepX = Math.max(ctx.measureText(text).width + fontSize * 3, fontSize * 8);
  const stepY = fontSize * 5;
  ctx.translate(width / 2, height / 2);
  ctx.rotate(-Math.PI / 6);
  const reach = Math.hypot(width, height);
  let row = 0;
  for (let y = -reach; y <= reach; y += stepY, row += 1) {
    const offset = row % 2 ? stepX / 2 : 0;
    for (let x = -reach; x <= reach; x += stepX) {
      // A light outline under dark text stays readable on both pale and dark pictures.
      ctx.lineWidth = Math.max(2, fontSize / 7);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.strokeText(text, x + offset, y);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
      ctx.fillText(text, x + offset, y);
    }
  }
  ctx.restore();
}

/**
 * The image's bytes with the watermark burned in, as a Blob of the SAME type. Falls back to the original blob
 * if anything about it is unsupported (it must never block a download).
 * @returns {Promise<Blob>}
 */
export async function stampImageBlob(blob, mime, text) {
  if (!text || !isStampable(mime)) return blob;
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    drawWatermark(ctx, canvas.width, canvas.height, text);
    const stamped = await new Promise((resolve) => canvas.toBlob(resolve, mime, 0.92));
    return stamped && stamped.type === mime ? stamped : blob;
  } catch {
    return blob;
  }
}
