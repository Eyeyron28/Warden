import { buildPdf } from './pdfWriter.js';

/**
 * Turns the edited pages into the file(s) to upload, and decides how hard to compress them so the result is under the 4 MB cap.
 *
 * `encode(index, quality)` gives a page's JPEG bytes (a Uint8Array) at a quality from 0 to 1; `sizeOf(index)` gives its
 * { width, height }. Qualities are tried from the best down: 0.85, then lower. Nothing here touches the DOM.
 */
export const LIMIT_BYTES = 4 * 1024 * 1024 - 8 * 1024; // the cap, less a little for the upload's own framing
export const QUALITIES = Object.freeze([0.85, 0.75, 0.65, 0.55, 0.45, 0.35]);

/** The smallest of the sizes as one PDF: the quality used, or null when even the lowest quality does not fit. */
async function planPdf(count, encode, sizeOf, limit, qualities) {
  for (const quality of qualities) {
    const pages = [];
    for (let index = 0; index < count; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      pages.push({ jpeg: await encode(index, quality), ...sizeOf(index) });
    }
    const bytes = buildPdf(pages);
    if (bytes.length <= limit) return { quality, bytes };
  }
  return null;
}

/** Each page as its own JPEG, each at the best quality that fits on its own. */
async function planImages(count, encode, limit, qualities) {
  const files = [];
  for (let index = 0; index < count; index += 1) {
    let kept = null;
    for (const quality of qualities) {
      // eslint-disable-next-line no-await-in-loop
      const bytes = await encode(index, quality);
      if (bytes.length <= limit) {
        kept = { quality, bytes };
        break;
      }
    }
    if (!kept) return { failedPage: index + 1 };
    files.push(kept);
  }
  return { files };
}

/**
 * @returns {Promise<
 *   { ok: true, format: 'pdf'|'images', files: Array<{ suffix: string, type: string, bytes: Uint8Array, quality: number }> }
 *   | { ok: false, format: 'pdf'|'images', reason: 'too_large', pages: number, separateWouldFit: boolean, failedPage?: number }
 * >}
 */
export async function planScan({ count, format, encode, sizeOf, limit = LIMIT_BYTES, qualities = QUALITIES }) {
  if (count < 1) throw new Error('There are no pages to save.');
  if (format === 'pdf') {
    const pdf = await planPdf(count, encode, sizeOf, limit, qualities);
    if (pdf) return { ok: true, format, files: [{ suffix: '', type: 'application/pdf', bytes: pdf.bytes, quality: pdf.quality }] };
    // Say whether the pages would fit one by one, so the person can be offered that instead of a silent failure.
    const separate = await planImages(count, encode, limit, qualities);
    return { ok: false, format, reason: 'too_large', pages: count, separateWouldFit: Boolean(separate.files) };
  }
  const result = await planImages(count, encode, limit, qualities);
  if (result.files) {
    return {
      ok: true,
      format: 'images',
      files: result.files.map((file, index) => ({ suffix: count > 1 ? ` page ${index + 1}` : '', type: 'image/jpeg', bytes: file.bytes, quality: file.quality })),
    };
  }
  return { ok: false, format: 'images', reason: 'too_large', pages: count, separateWouldFit: false, failedPage: result.failedPage };
}
